// Proxy launcher with PID+startTime lock verification
// Starts proxy in background, launches claude, kills proxy on exit
//
// The proxy is provider-agnostic: it routes by model name (e.g. "codex" → codex-oauth,
// "gemini" → gemini-oauth). So if claude-codex started the proxy and claude-gemini
// runs next, it just reuses the same proxy — no restart needed.

import { readFile, unlink } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { spawn, execSync } from "child_process";

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

/** Kill whatever is listening on the port (lsof-based fallback) */
function killPortOccupant(port) {
  try {
    const pids = execSync(`lsof -ti:${port}`, { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
    for (const p of pids) {
      try { process.kill(Number(p), "SIGTERM"); } catch {}
    }
    // Wait a moment for processes to die
    for (let i = 0; i < 20; i++) {
      const alive = pids.some(p => { try { process.kill(Number(p), 0); return true; } catch { return false; } });
      if (!alive) return true;
      // Sync sleep via execSync (we're in startup, blocking is fine)
      execSync("sleep 0.1");
    }
    // Force kill remaining
    for (const p of pids) {
      try { process.kill(Number(p), "SIGKILL"); } catch {}
    }
    return true;
  } catch {
    return false; // lsof failed = nothing on port
  }
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
 *
 * Strategy:
 * 1. Healthy proxy already running? → Reuse it (proxy is provider-agnostic)
 * 2. Stale/zombie process on port?  → Kill it, start fresh
 * 3. Port free?                     → Start new proxy
 */
export async function launchProxy({ rootDir, provider, model, defaultModel, startedBy, forceRestart = false, extraArgs = [] }) {
  const PORT = Number(process.env.CLAUDE_PROXY_PORT || 17870);
  let weStartedProxy = false;

  // Step 1: Check if a healthy proxy is already running
  const health = await fetchHealth(PORT);

  if (health && !forceRestart) {
    // Healthy proxy exists — reuse it regardless of who started it.
    // The proxy routes by model name, so codex/gemini/glm all work on the same instance.
    console.log(`  Proxy already running (PID ${health.pid}, ${health.active?.provider || "unknown"}:${health.active?.model || "auto"})`);
  } else {
    // Either no healthy proxy, or force restart requested

    // Step 2: Clean up anything occupying the port
    if (health && forceRestart) {
      // Healthy but we want a restart — kill via PID lock or health PID
      const lock = await readLock();
      const pidToKill = lock?.pid || health.pid;
      if (pidToKill) {
        console.log(`  Restarting proxy (killing PID ${pidToKill})...`);
        await killPid(pidToKill);
        await new Promise(r => setTimeout(r, 300));
      }
    } else {
      // Not healthy — check for zombie/stale processes
      const lock = await readLock();
      if (lock?.pid && isAlive(lock.pid)) {
        // Process alive but not responding to health — zombie proxy
        console.log(`  Stale proxy detected (PID ${lock.pid}, not responding). Killing...`);
        await killPid(lock.pid);
        await new Promise(r => setTimeout(r, 300));
      }
      await removeLock();

      // Also kill anything else squatting on the port (e.g. orphaned tsx process)
      killPortOccupant(PORT);
      await new Promise(r => setTimeout(r, 200));
    }

    // Step 3: Start a new proxy
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
  const health = await fetchHealth(PORT);
  if (health) {
    const lock = await readLock();
    const pid = lock?.pid || health.pid;
    console.log(`  Stopping proxy (PID ${pid})...`);
    if (await killPid(pid)) console.log("  Stopped.");
    else {
      killPortOccupant(PORT);
      console.log("  Stopped (force).");
    }
  } else {
    // No healthy proxy, but maybe zombie?
    const lock = await readLock();
    if (lock?.pid && isAlive(lock.pid)) {
      console.log(`  Killing stale proxy (PID ${lock.pid})...`);
      await killPid(lock.pid);
      console.log("  Killed.");
    } else {
      killPortOccupant(PORT);
      await removeLock();
      console.log("  No proxy running.");
    }
  }
}

export async function proxyStatus() {
  const PORT = Number(process.env.CLAUDE_PROXY_PORT || 17870);
  const health = await fetchHealth(PORT);
  const lock = await readLock();
  if (health) {
    console.log(`  PID:        ${health.pid}`);
    console.log(`  Port:       ${PORT}`);
    console.log(`  Started:    ${new Date(health.startedAt).toLocaleString()}`);
    console.log(`  Healthy:    yes`);
    if (health.active) console.log(`  Provider:   ${health.active.provider}:${health.active.model}`);
    if (lock?.pid && lock.pid !== health.pid) {
      console.log(`  Warning:    PID lock (${lock.pid}) doesn't match running proxy`);
    }
  } else if (lock?.pid && isAlive(lock.pid)) {
    console.log(`  PID:        ${lock.pid}`);
    console.log(`  Port:       ${PORT}`);
    console.log(`  Healthy:    no (process alive but not responding)`);
  } else {
    console.log("  No proxy running.");
  }
}
