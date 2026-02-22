import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { spawn, ChildProcess } from "child_process";

// We test the logic directly - not the module (which hardcodes ~/.claude-proxy)
// So we replicate the core functions with a configurable path for isolation

const TEST_DIR = join(tmpdir(), `ccx-pid-test-${process.pid}`);
const TEST_PID_FILE = join(TEST_DIR, "proxy.pid");

interface PidLock {
  pid: number;
  startedAt: number;
}

async function writePid(pid: number, startedAt: number) {
  await mkdir(TEST_DIR, { recursive: true });
  const lock: PidLock = { pid, startedAt };
  await writeFile(TEST_PID_FILE, JSON.stringify(lock), "utf-8");
}

async function readPid(): Promise<PidLock | null> {
  try {
    return JSON.parse(await readFile(TEST_PID_FILE, "utf-8"));
  } catch {
    return null;
  }
}

async function removePid() {
  try {
    await unlink(TEST_PID_FILE);
  } catch {}
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM";
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  await removePid();
});

afterEach(async () => {
  await removePid();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("PID lock file", () => {
  it("writes and reads back pid + startedAt", async () => {
    const now = Date.now();
    await writePid(process.pid, now);
    const lock = await readPid();
    expect(lock).not.toBeNull();
    expect(lock!.pid).toBe(process.pid);
    expect(lock!.startedAt).toBe(now);
  });

  it("returns null when no lock file exists", async () => {
    const lock = await readPid();
    expect(lock).toBeNull();
  });

  it("removes lock file cleanly", async () => {
    await writePid(process.pid, Date.now());
    await removePid();
    const lock = await readPid();
    expect(lock).toBeNull();
  });

  it("removePid is safe when file already gone", async () => {
    // Should not throw
    await removePid();
    await removePid();
  });
});

describe("isAlive", () => {
  it("returns true for own process", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it("returns true for parent process", () => {
    expect(isAlive(process.ppid)).toBe(true);
  });

  it("returns false for a clearly dead PID", () => {
    // PID 99999999 almost certainly doesn't exist
    expect(isAlive(99999999)).toBe(false);
  });
});

describe("stale lock detection (PID recycling)", () => {
  it("detects stale lock when PID is dead", async () => {
    // Write a lock with a PID that doesn't exist
    await writePid(99999999, Date.now());
    const lock = await readPid();
    expect(lock).not.toBeNull();
    expect(isAlive(lock!.pid)).toBe(false);
    // CLI would clean this up
  });

  it("detects recycled PID via startedAt mismatch", async () => {
    // Simulate: lock says process started at time X,
    // but healthz returns a different startedAt = different process reused the PID
    const lockTime = 1000000;
    const healthTime = 9999999;
    await writePid(process.pid, lockTime);
    const lock = await readPid();
    // Cross-check: same PID but times don't match = recycled
    const timeMatch = Math.abs(healthTime - lock!.startedAt) < 5000;
    expect(timeMatch).toBe(false);
  });

  it("confirms our process when PID + startedAt both match", async () => {
    const now = Date.now();
    await writePid(process.pid, now);
    const lock = await readPid();
    // Simulate healthz returning same values
    const healthPid = process.pid;
    const healthStartedAt = now + 100; // gateway writes slightly after module load
    const pidMatch = healthPid === lock!.pid;
    const timeMatch = Math.abs(healthStartedAt - lock!.startedAt) < 5000;
    expect(pidMatch).toBe(true);
    expect(timeMatch).toBe(true);
  });
});

describe("cross-platform process.kill(pid, 0)", () => {
  it("works for signal 0 check without killing", () => {
    // This is the core cross-platform mechanism - must work on mac/linux/windows
    const before = isAlive(process.pid);
    // We're still alive after checking
    expect(before).toBe(true);
    expect(isAlive(process.pid)).toBe(true);
  });
});

describe("gateway healthz integration", () => {
  let proxy: ChildProcess;
  const PORT = 18999; // use a non-standard port for test isolation

  afterEach(async () => {
    if (proxy && !proxy.killed) {
      proxy.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      if (!proxy.killed) proxy.kill("SIGKILL");
    }
  });

  it("healthz returns pid and startedAt", async () => {
    const rootDir = join(import.meta.dirname!, "..");
    proxy = spawn(
      "npx",
      ["tsx", join(rootDir, "adapters", "anthropic-gateway.ts")],
      {
        cwd: rootDir,
        env: { ...process.env, CLAUDE_PROXY_PORT: String(PORT) },
        stdio: "pipe",
      }
    );

    // Wait for proxy to be ready
    let ready = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const resp = await fetch(`http://127.0.0.1:${PORT}/healthz`);
        if (resp.ok) {
          ready = true;
          break;
        }
      } catch {}
    }
    expect(ready).toBe(true);

    const resp = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    const data = await resp.json();
    expect(data.ok).toBe(true);
    expect(typeof data.pid).toBe("number");
    expect(typeof data.startedAt).toBe("number");

    // healthz PID should be a real alive process
    let alive = false;
    try { process.kill(data.pid, 0); alive = true; } catch {}
    expect(alive).toBe(true);
  }, 15000);

  it("healthz response is self-consistent across calls", async () => {
    const rootDir = join(import.meta.dirname!, "..");
    proxy = spawn(
      "npx",
      ["tsx", join(rootDir, "adapters", "anthropic-gateway.ts")],
      {
        cwd: rootDir,
        env: { ...process.env, CLAUDE_PROXY_PORT: String(PORT) },
        stdio: "pipe",
      }
    );

    let ready = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const resp = await fetch(`http://127.0.0.1:${PORT}/healthz`);
        if (resp.ok) {
          ready = true;
          break;
        }
      } catch {}
    }
    expect(ready).toBe(true);

    // Two consecutive healthz calls should return identical pid + startedAt
    const h1 = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json();
    const h2 = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json();

    expect(h1.pid).toBe(h2.pid);
    expect(h1.startedAt).toBe(h2.startedAt);
    expect(h1.ok).toBe(true);
    expect(h2.ok).toBe(true);
  }, 15000);
});
