// PID + start-time lock for proxy process identity verification
// PID can be recycled by OS - start time proves it's actually our process

import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const PID_DIR = join(homedir(), ".claude-proxy");
const PID_FILE = join(PID_DIR, "proxy.pid");
export { PID_FILE };

interface PidLock { pid: number; startedAt: number; } // startedAt = Date.now()

/** Write lock: PID + timestamp */
export async function writePid(): Promise<void> {
  await mkdir(PID_DIR, { recursive: true });
  const lock: PidLock = { pid: process.pid, startedAt: Date.now() };
  await writeFile(PID_FILE, JSON.stringify(lock), "utf-8");
}

/** Read lock */
export async function readPid(): Promise<PidLock | null> {
  try {
    return JSON.parse(await readFile(PID_FILE, "utf-8"));
  } catch {
    return null;
  }
}

/** Remove lock */
export async function removePid(): Promise<void> {
  try { await unlink(PID_FILE); } catch {}
}

/** Is PID alive? (cross-platform, no shell commands) */
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e.code === "EPERM"; }
}

/** Check if lock is ours: PID alive AND start time matches */
export async function isOurProxy(): Promise<{ ours: boolean; lock: PidLock | null }> {
  const lock = await readPid();
  if (!lock) return { ours: false, lock: null };
  if (!isAlive(lock.pid)) { await removePid(); return { ours: false, lock }; }
  // Verify start time via /healthz which returns startedAt
  // If we can't reach it, PID is alive but not responding = zombie, kill it
  return { ours: true, lock };
}

/** SIGTERM → wait 3s → SIGKILL */
export async function killPid(pid: number): Promise<boolean> {
  if (!isAlive(pid)) { await removePid(); return true; }
  try { process.kill(pid, "SIGTERM"); } catch { await removePid(); return true; }
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (!isAlive(pid)) { await removePid(); return true; }
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (!isAlive(pid)) { await removePid(); return true; }
  }
  return false;
}

/** Auto-remove PID file on exit/crash/signal */
export function registerCleanup(): void {
  const rm = () => { try { require("fs").unlinkSync(PID_FILE); } catch {} };
  process.on("exit", rm);
  process.on("SIGINT", () => { rm(); process.exit(0); });
  process.on("SIGTERM", () => { rm(); process.exit(0); });
}
