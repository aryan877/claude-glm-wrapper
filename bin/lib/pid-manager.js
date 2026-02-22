// PID manager — ALL process/pid logic lives here
//
// Used by:
//   - Gateway (anthropic-gateway.ts) → writePid(), registerCleanup()
//   - Launcher (proxy-launcher.js)   → readLock(), killPid(), killPortOccupant(), fetchHealth(), etc.

import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

const PID_DIR = join(homedir(), ".claude-proxy");
const PID_FILE = join(PID_DIR, "proxy.pid");

// ── Write / Read / Remove lock ───────────────────────────────────────

/** Write lock: current process PID + timestamp */
export async function writePid() {
  await mkdir(PID_DIR, { recursive: true });
  await writeFile(PID_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf-8");
}

/** Read lock file → { pid, startedAt } or null */
export async function readLock() {
  try { return JSON.parse(await readFile(PID_FILE, "utf-8")); }
  catch { return null; }
}

/** Remove lock file (safe if already gone) */
export async function removeLock() {
  try { await unlink(PID_FILE); } catch {}
}

// ── Process checks ───────────────────────────────────────────────────

/** Is PID alive? (cross-platform, no shell commands) */
export function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

/** Fetch /healthz from the proxy on a given port */
export async function fetchHealth(port) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 2000);
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: c.signal });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// ── Kill helpers ─────────────────────────────────────────────────────

/** SIGTERM → wait 3s → SIGKILL a specific PID, remove lock when dead */
export async function killPid(pid) {
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
export function killPortOccupant(port) {
  try {
    const pids = execSync(`lsof -ti:${port}`, { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
    for (const p of pids) {
      try { process.kill(Number(p), "SIGTERM"); } catch {}
    }
    for (let i = 0; i < 20; i++) {
      const alive = pids.some(p => { try { process.kill(Number(p), 0); return true; } catch { return false; } });
      if (!alive) return true;
      execSync("sleep 0.1");
    }
    for (const p of pids) {
      try { process.kill(Number(p), "SIGKILL"); } catch {}
    }
    return true;
  } catch {
    return false;
  }
}

// ── Gateway cleanup ──────────────────────────────────────────────────

/** Auto-remove PID file on exit/crash/signal (call from gateway only) */
export function registerCleanup() {
  const rm = () => { try { unlinkSync(PID_FILE); } catch {} };
  process.on("exit", rm);
  process.on("SIGINT", () => { rm(); process.exit(0); });
  process.on("SIGTERM", () => { rm(); process.exit(0); });
}
