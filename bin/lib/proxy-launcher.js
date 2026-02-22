// Proxy launcher with PID+startTime lock verification
// Starts proxy in background, launches claude, kills proxy on exit

import { readFile, unlink } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "child_process";

const PID_FILE = join(homedir(), ".claude-proxy", "proxy.pid");

// ── PID lock helpers ─────────────────────────────────────────────────

async function readLock() {
  try { return JSON.parse(await readFile(PID_FILE, "utf-8")); }
  catch { return null; }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

async function removeLock() {
  try { await unlink(PID_FILE); } catch {}
}

async function fetchHealth(port) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 2000);
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: c.signal });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function verifyOurs(port) {
  const lock = await readLock();
  if (!lock?.pid) return { ours: false, lock: null, health: null };
  if (!isAlive(lock.pid)) { await removeLock(); return { ours: false, lock, health: null }; }
  const health = await fetchHealth(port);
  if (!health) return { ours: false, lock, health: null };
  const pidMatch = health.pid === lock.pid;
  const timeMatch = Math.abs((health.startedAt || 0) - (lock.startedAt || 0)) < 5000;
  return { ours: pidMatch && timeMatch, lock, health };
}

async function killPid(pid) {
  if (!isAlive(pid)) { await removeLock(); return true; }
  try { process.kill(pid, "SIGTERM"); } catch { await removeLock(); return true; }
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (!isAlive(pid)) { await removeLock(); return true; }
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (!isAlive(pid)) { await removeLock(); return true; }
  }
  return false;
}

// ── Wait for proxy health ────────────────────────────────────────────

async function waitForProxy(port, maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const h = await fetchHealth(port);
    if (h) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Start proxy (background), launch claude, kill proxy on exit.
 */
export async function launchProxy({ rootDir, provider, model, defaultModel, startedBy, forceRestart = false, extraArgs = [] }) {
  const PORT = Number(process.env.CLAUDE_PROXY_PORT || 17870);
  const { ours, lock } = await verifyOurs(PORT);
  let weStartedProxy = false;

  if (ours && !forceRestart) {
    console.log(`  Proxy already running (PID ${lock.pid})`);
  } else {
    if (ours && forceRestart) {
      console.log(`  Killing existing proxy (PID ${lock.pid})...`);
      if (!await killPid(lock.pid)) {
        console.error(`  Failed to kill PID ${lock.pid}. Try: kill -9 ${lock.pid}`);
        process.exit(1);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    if (!ours && lock?.pid && isAlive(lock.pid)) {
      console.log(`  Stale lock (PID ${lock.pid} is a different process). Cleaning up.`);
      await removeLock();
      const h = await fetchHealth(PORT);
      if (h) {
        console.log(`  Port ${PORT} in use by unknown process. Kill it: lsof -ti:${PORT} | xargs kill`);
        process.exit(1);
      }
    }

    if (!ours && !lock) {
      const h = await fetchHealth(PORT);
      if (h && !forceRestart) {
        console.log(`  Proxy already running on port ${PORT} (started externally)`);
        // Reuse it, don't start a new one
      } else if (h && forceRestart) {
        console.log(`  Port ${PORT} in use (no lock). Kill manually: lsof -ti:${PORT} | xargs kill`);
        process.exit(1);
      } else {
        // Start proxy in background
        weStartedProxy = true;
        const proxyLog = join(homedir(), ".claude-proxy", "proxy.log");
        const proxy = spawn("npx", ["tsx", join(rootDir, "adapters", "anthropic-gateway.ts")], {
          cwd: rootDir,
          env: { ...process.env, CCX_DEFAULT_PROVIDER: provider, CCX_DEFAULT_MODEL: model },
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
        });

        // Pipe proxy output to log file (and also to console until claude starts)
        const fs = await import("fs");
        const logStream = fs.createWriteStream(proxyLog, { flags: "a" });
        proxy.stdout.pipe(logStream);
        proxy.stderr.pipe(logStream);

        // Also show proxy startup output
        proxy.stdout.on("data", (d) => process.stdout.write(d));
        proxy.stderr.on("data", (d) => process.stderr.write(d));

        console.log(`  Starting proxy in background...`);
        const ready = await waitForProxy(PORT);
        if (!ready) {
          console.error(`  Proxy failed to start. Check: ${proxyLog}`);
          proxy.kill("SIGTERM");
          process.exit(1);
        }

        // Stop showing proxy output now that claude will take over
        proxy.stdout.removeAllListeners("data");
        proxy.stderr.removeAllListeners("data");

        // Kill proxy when this process exits
        const cleanup = () => {
          try { proxy.kill("SIGTERM"); } catch {}
        };
        process.on("exit", cleanup);
        process.on("SIGINT", () => { cleanup(); process.exit(0); });
        process.on("SIGTERM", () => { cleanup(); process.exit(0); });
      }
    }
  }

  // Launch claude
  console.log("");

  const claudeArgs = ["--model", defaultModel, ...extraArgs];
  const claude = spawn("claude", claudeArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || "local-proxy-token",
    },
  });

  claude.on("error", (err) => {
    if (err.message.includes("ENOENT")) {
      console.error("  'claude' command not found. Install Claude Code first.");
    } else {
      console.error(`  Failed to launch claude: ${err.message}`);
    }
    process.exit(1);
  });

  claude.on("close", (code) => {
    process.exit(code ?? 0);
  });
}

export async function stopProxy() {
  const PORT = Number(process.env.CLAUDE_PROXY_PORT || 17870);
  const { ours, lock } = await verifyOurs(PORT);
  if (ours) {
    console.log(`  Stopping proxy (PID ${lock.pid})...`);
    if (await killPid(lock.pid)) console.log("  Stopped.");
    else console.error(`  Failed. Try: kill -9 ${lock.pid}`);
  } else {
    console.log("  No managed proxy running.");
  }
}

export async function proxyStatus() {
  const PORT = Number(process.env.CLAUDE_PROXY_PORT || 17870);
  const { ours, lock, health } = await verifyOurs(PORT);
  if (ours) {
    console.log(`  PID:        ${lock.pid}`);
    console.log(`  Port:       ${PORT}`);
    console.log(`  Started:    ${new Date(lock.startedAt).toLocaleString()}`);
    console.log(`  Healthy:    ${health ? "yes" : "no"}`);
    if (health?.active) console.log(`  Provider:   ${health.active.provider}:${health.active.model}`);
  } else {
    const h = await fetchHealth(PORT);
    if (h) console.log(`  Proxy on port ${PORT} (unmanaged, no matching lock)`);
    else console.log("  No proxy running.");
  }
}
