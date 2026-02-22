import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { spawn, execSync, ChildProcess } from "child_process";

// ── Helpers (replicated from proxy-launcher.js for test isolation) ────

const TEST_DIR = join(tmpdir(), `ccx-launcher-test-${process.pid}`);
const TEST_PID_FILE = join(TEST_DIR, "proxy.pid");

interface PidLock {
  pid: number;
  startedAt: number;
}

async function writeLock(pid: number, startedAt: number) {
  await mkdir(TEST_DIR, { recursive: true });
  await writeFile(TEST_PID_FILE, JSON.stringify({ pid, startedAt }), "utf-8");
}

async function readLock(): Promise<PidLock | null> {
  try {
    return JSON.parse(await readFile(TEST_PID_FILE, "utf-8"));
  } catch {
    return null;
  }
}

async function removeLock() {
  try { await unlink(TEST_PID_FILE); } catch {}
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM";
  }
}

async function fetchHealth(port: number) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 2000);
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: c.signal });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  await removeLock();
});

afterEach(async () => {
  await removeLock();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("launcher decision logic", () => {
  it("detects healthy proxy and would reuse it", async () => {
    // Simulate: health check returns data → should reuse, not restart
    const PORT = 18990;
    const rootDir = join(import.meta.dirname!, "..");
    const proxy = spawn(
      "npx",
      ["tsx", join(rootDir, "adapters", "anthropic-gateway.ts")],
      {
        cwd: rootDir,
        env: { ...process.env, CLAUDE_PROXY_PORT: String(PORT), CCX_DEFAULT_PROVIDER: "codex-oauth", CCX_DEFAULT_MODEL: "gpt-5.3-codex" },
        stdio: "pipe",
      }
    );

    try {
      // Wait for proxy
      let ready = false;
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 250));
        try {
          const resp = await fetch(`http://127.0.0.1:${PORT}/healthz`);
          if (resp.ok) { ready = true; break; }
        } catch {}
      }
      expect(ready).toBe(true);

      // Health check succeeds — this is the "reuse" path
      const health = await fetchHealth(PORT);
      expect(health).not.toBeNull();
      expect(health.ok).toBe(true);
      expect(health.active.provider).toBe("codex-oauth");

      // Key assertion: proxy is provider-agnostic, so a gemini launcher
      // would see this healthy proxy and reuse it (not kill it)
      // The model routing in map.ts handles provider selection
      expect(typeof health.pid).toBe("number");
    } finally {
      proxy.kill("SIGTERM");
      await new Promise(r => setTimeout(r, 500));
      if (!proxy.killed) proxy.kill("SIGKILL");
    }
  }, 15000);

  it("detects zombie proxy (alive PID, no health response)", async () => {
    // Simulate: a process exists but isn't responding on the port
    // The launcher should detect this as "stale" and kill it
    const zombiePid = process.pid; // our own PID is alive
    const port = 18991; // nothing listening here

    await writeLock(zombiePid, Date.now());

    const lock = await readLock();
    expect(lock).not.toBeNull();
    expect(isAlive(lock!.pid)).toBe(true);

    // But health fails (nothing on port)
    const health = await fetchHealth(port);
    expect(health).toBeNull();

    // This is exactly the "stale proxy" case:
    // PID alive + health fails → launcher should kill PID and start fresh
  });

  it("detects dead PID as not-stale (already gone)", async () => {
    await writeLock(99999999, Date.now());
    const lock = await readLock();
    expect(lock).not.toBeNull();
    expect(isAlive(lock!.pid)).toBe(false);
    // Dead PID + no health = port is free, just start a new proxy
  });

  it("no lock + no health = fresh start", async () => {
    const lock = await readLock();
    expect(lock).toBeNull();

    const health = await fetchHealth(18992);
    expect(health).toBeNull();

    // Both null → launcher starts a brand new proxy
  });
});

describe("provider-agnostic routing", () => {
  let proxy: ChildProcess;
  const PORT = 18993;

  afterEach(async () => {
    if (proxy && !proxy.killed) {
      proxy.kill("SIGTERM");
      await new Promise(r => setTimeout(r, 500));
      if (!proxy.killed) proxy.kill("SIGKILL");
    }
  });

  it("proxy started with codex-oauth default still has all routes available", async () => {
    const rootDir = join(import.meta.dirname!, "..");
    proxy = spawn(
      "npx",
      ["tsx", join(rootDir, "adapters", "anthropic-gateway.ts")],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          CLAUDE_PROXY_PORT: String(PORT),
          CCX_DEFAULT_PROVIDER: "codex-oauth",
          CCX_DEFAULT_MODEL: "gpt-5.3-codex",
        },
        stdio: "pipe",
      }
    );

    // Wait for proxy
    let ready = false;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      try {
        const resp = await fetch(`http://127.0.0.1:${PORT}/healthz`);
        if (resp.ok) { ready = true; break; }
      } catch {}
    }
    expect(ready).toBe(true);

    // Verify the proxy reports codex-oauth as default
    const health = await fetchHealth(PORT);
    expect(health.active.provider).toBe("codex-oauth");

    // But the /v1/messages endpoint exists (proxy can route any provider)
    // We can't send a real completion request without auth, but we can verify
    // the endpoint exists by sending an invalid request and checking it's not 404
    const resp = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemini", messages: [{ role: "user", content: "test" }] }),
    });
    // Should NOT be 404 (endpoint exists), will be an auth/provider error instead
    expect(resp.status).not.toBe(404);
  }, 15000);
});

describe("killPortOccupant (lsof-based cleanup)", () => {
  it("lsof finds process on a known port", async () => {
    // Start a simple server to occupy a port, then verify lsof can find it
    const PORT = 18994;
    const server = spawn("node", ["-e", `
      require("http").createServer((q,s) => s.end("ok")).listen(${PORT}, "127.0.0.1", () => {
        process.stdout.write("ready");
      });
    `], { stdio: "pipe" });

    try {
      // Wait for server to start
      await new Promise<void>((resolve) => {
        server.stdout!.on("data", (d) => {
          if (d.toString().includes("ready")) resolve();
        });
        setTimeout(resolve, 3000);
      });

      // Verify lsof can find it
      let pids = "";
      try {
        pids = execSync(`lsof -ti:${PORT}`, { encoding: "utf-8" }).trim();
      } catch {}
      expect(pids).not.toBe("");
      expect(pids).toContain(String(server.pid));
    } finally {
      server.kill("SIGTERM");
      await new Promise(r => setTimeout(r, 300));
    }
  }, 10000);
});
