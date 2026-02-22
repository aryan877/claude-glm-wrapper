// PID lock file manager — GATEWAY SIDE (writer + cleanup)
//
// The gateway writes its PID + startedAt on startup and removes it on exit.
// The CLI launchers (bin/lib/proxy-launcher.js) read this file to detect
// running/stale proxies. They share the DATA (proxy.pid), not code.

import { writeFile, mkdir } from "fs/promises";
import { unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const PID_DIR = join(homedir(), ".claude-proxy");
const PID_FILE = join(PID_DIR, "proxy.pid");
export { PID_FILE };

/** Write lock: PID + timestamp */
export async function writePid(): Promise<void> {
  await mkdir(PID_DIR, { recursive: true });
  const lock = { pid: process.pid, startedAt: Date.now() };
  await writeFile(PID_FILE, JSON.stringify(lock), "utf-8");
}

/** Auto-remove PID file on exit/crash/signal */
export function registerCleanup(): void {
  const rm = () => { try { unlinkSync(PID_FILE); } catch {} };
  process.on("exit", rm);
  process.on("SIGINT", () => { rm(); process.exit(0); });
  process.on("SIGTERM", () => { rm(); process.exit(0); });
}
