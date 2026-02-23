#!/usr/bin/env node
// claude-codex-d - OpenAI Codex via Claude Code with --dangerously-skip-permissions
// Shortcut for: claude-codex -d

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
const child = spawn("node", [join(__dirname, "claude-codex.js"), "-d", ...args], {
  stdio: "inherit",
});

child.on("close", (code) => process.exit(code ?? 0));
