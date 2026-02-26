#!/usr/bin/env node

// claude-gemini - Google Gemini via Claude Code
// Starts proxy, prints available models, launches claude, kills proxy on exit
// Usage: claude-gemini [--status] [--logout] [--restart] [--stop] [--proxy-status] [-d]

import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { launchProxy, stopProxy, proxyStatus } from "./lib/proxy-launcher.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");

const GOOGLE_AUTH_FILE = join(homedir(), ".claude-proxy", "google-oauth.json");

async function loadTokens() {
  try {
    const data = await readFile(GOOGLE_AUTH_FILE, "utf-8");
    const parsed = JSON.parse(data);
    if (parsed.access_token && parsed.refresh_token) return parsed;
  } catch {}
  return null;
}

async function main() {
  const args = process.argv.slice(2);

  console.log("");
  console.log("  claude-gemini - Google Gemini via Claude Code");
  console.log("  =============================================");
  console.log("");

  if (args.includes("--stop")) { await stopProxy(); console.log(""); return; }
  if (args.includes("--proxy-status")) { await proxyStatus(); console.log(""); return; }

  if (args.includes("--logout")) {
    try { const { unlink } = await import("fs/promises"); await unlink(GOOGLE_AUTH_FILE); console.log("  Logged out."); }
    catch { console.log("  Already logged out."); }
    return;
  }

  const tokens = await loadTokens();

  if (args.includes("--status")) {
    if (tokens) {
      console.log(`  Status:  Authenticated`);
      console.log(`  Email:   ${tokens.email || "unknown"}`);
      console.log(`  Project: ${tokens.project_id || "none (standard API)"}`);
      console.log(`  Mode:    ${tokens.project_id ? "Code Assist" : "Standard API"}`);
      const m = tokens.expires_at ? Math.round((tokens.expires_at - Date.now()) / 1000 / 60) : 0;
      console.log(`  Token:   ${m > 0 ? `expires in ${m} min` : "expired (auto-refreshes)"}`);
    } else {
      console.log("  Not authenticated. Run claude-gemini to log in.");
    }
    console.log("");
    return;
  }

  // Auth info
  if (tokens) {
    console.log(`  Google:  ${tokens.email || "unknown"}${tokens.project_id ? ` (Code Assist: ${tokens.project_id})` : ""}`);
  } else {
    console.log("  Google: Not authenticated");
    console.log("  Login at: http://127.0.0.1:17870/google/login");
  }
  console.log("");

  // Available models
  console.log("  Models (use with /model):");
  console.log("  ─────────────────────────────────────────────");
  console.log("    gemini         gemini-3-pro-preview      (default)");
  console.log("    gemini-pro     gemini-3-pro-preview");
  console.log("    gemini-flash   gemini-3-flash-preview");
  console.log("    gemini-31p     gemini-3.1-pro-preview");
  console.log("    gemini-31f     gemini-3.1-flash-preview");
  console.log("    gemini-25p     gemini-2.5-pro");
  console.log("    gemini-25f     gemini-2.5-flash");
  console.log("");
  console.log("  Thinking (append @level to any model):");
  console.log("  ─────────────────────────────────────────────");
  console.log("    @low           Low thinking");
  console.log("    @medium        Medium (3.1/Flash only)");
  console.log("    @high          Full thinking              (default)");
  console.log("");
  console.log("  Examples: /model gemini-flash@low  /model gemini-25p@xhigh");
  console.log("");

  // Extra flags
  const extraArgs = [];
  if (args.includes("-d") || args.includes("--dangerously-skip-permissions")) {
    extraArgs.push("--dangerously-skip-permissions");
    console.log("  Running with --dangerously-skip-permissions");
    console.log("");
  }

  const claudePassthrough = args.filter(a =>
    !["--restart", "--stop", "--proxy-status", "--status", "--logout", "-d", "--dangerously-skip-permissions"].includes(a)
  );

  await launchProxy({
    rootDir,
    provider: "gemini-oauth",
    model: "gemini-3-pro-preview",
    defaultModel: "gemini",
    startedBy: "claude-gemini",
    forceRestart: args.includes("--restart"),
    extraArgs: [...extraArgs, ...claudePassthrough],
  });
}

main().catch((err) => { console.error(err.message); process.exit(1); });
