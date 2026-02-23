#!/usr/bin/env node

// ccx - Multi-provider proxy for Claude Code (API key based)
// Starts proxy, prints available models, launches claude, kills proxy on exit
// Usage: ccx [--setup] [--status] [--restart] [--stop] [--proxy-status] [-d]

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { launchProxy, stopProxy, proxyStatus } from "./lib/proxy-launcher.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");

const CCX_HOME = join(homedir(), ".claude-proxy");
const ENV_FILE = join(CCX_HOME, ".env");

const ENV_TEMPLATE = `# Claude Proxy Configuration
# Edit this file to add your API keys

# OpenAI (optional)
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1

# OpenRouter (optional)
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_REFERER=
OPENROUTER_TITLE=Claude Code via ccx

# Gemini (optional)
GEMINI_API_KEY=
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta

# Z.AI GLM (optional - for glm: routing)
GLM_UPSTREAM_URL=https://api.z.ai/api/anthropic
ZAI_API_KEY=

# Anthropic (optional - for anthropic: routing)
ANTHROPIC_UPSTREAM_URL=https://api.anthropic.com
ANTHROPIC_API_KEY=
ANTHROPIC_VERSION=2023-06-01

# Proxy settings
CLAUDE_PROXY_PORT=17870
`;

function setup() {
  console.log("  Setting up ~/.claude-proxy/.env...");
  mkdirSync(CCX_HOME, { recursive: true });

  if (existsSync(ENV_FILE)) {
    console.log(`  Existing .env found. Edit it manually at: ${ENV_FILE}`);
    return;
  }

  writeFileSync(ENV_FILE, ENV_TEMPLATE, "utf-8");
  console.log(`  Created ${ENV_FILE}`);
  console.log("");
  console.log("  Edit it to add your API keys, then run: ccx");
  console.log("");
  console.log("  Example:");
  console.log(`    nano ${ENV_FILE}`);
}

function showStatus() {
  console.log("  Configuration: ~/.claude-proxy/.env");
  console.log("");

  if (!existsSync(ENV_FILE)) {
    console.log("  No .env file found. Run: ccx --setup");
    return;
  }

  const env = readFileSync(ENV_FILE, "utf-8");
  const keys = [
    ["ZAI_API_KEY", "Z.AI GLM"],
    ["OPENAI_API_KEY", "OpenAI"],
    ["OPENROUTER_API_KEY", "OpenRouter"],
    ["GEMINI_API_KEY", "Gemini"],
    ["ANTHROPIC_API_KEY", "Anthropic"],
  ];

  for (const [key, label] of keys) {
    const match = env.match(new RegExp(`^${key}=(.+)$`, "m"));
    const value = match?.[1]?.trim();
    const status = value ? "configured" : "not set";
    console.log(`  ${label.padEnd(14)} ${status}`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  console.log("");
  console.log("  ccx - Multi-provider proxy for Claude Code");
  console.log("  ===========================================");
  console.log("");

  if (args.includes("--setup")) { setup(); console.log(""); return; }
  if (args.includes("--stop")) { await stopProxy(); console.log(""); return; }
  if (args.includes("--proxy-status")) { await proxyStatus(); console.log(""); return; }

  if (args.includes("--status")) { showStatus(); console.log(""); return; }

  // Load .env into process.env
  if (existsSync(ENV_FILE)) {
    const { config } = await import("dotenv");
    config({ path: ENV_FILE });
  }

  // Available models
  console.log("  Model prefixes (use with /model):");
  console.log("  ─────────────────────────────────────────────");
  console.log("    glm            glm-5                  (default)");
  console.log("    glm5           glm-5");
  console.log("    glm47          glm-4.7");
  console.log("    glm45          glm-4.5");
  console.log("    flash          glm-4-flash");
  console.log("");
  console.log("  Other providers (if configured in .env):");
  console.log("  ─────────────────────────────────────────────");
  console.log("    openai:<model>      OpenAI models");
  console.log("    openrouter:<model>  OpenRouter models");
  console.log("    gemini:<model>      Google Gemini models");
  console.log("    anthropic:<model>   Anthropic Claude models");
  console.log("");
  console.log("  Switch models in-session: /model <shortcut or provider:model>");
  console.log("");

  // Extra flags
  const extraArgs = [];
  if (args.includes("-d") || args.includes("--dangerously-skip-permissions")) {
    extraArgs.push("--dangerously-skip-permissions");
    console.log("  Running with --dangerously-skip-permissions");
    console.log("");
  }

  // Filter out our flags, pass the rest to claude
  const claudePassthrough = args.filter(a =>
    !["--restart", "--stop", "--proxy-status", "--status", "--setup", "-d", "--dangerously-skip-permissions"].includes(a)
  );

  await launchProxy({
    rootDir,
    provider: "glm",
    model: "glm-5",
    defaultModel: "glm",
    startedBy: "ccx",
    forceRestart: args.includes("--restart"),
    extraArgs: [...extraArgs, ...claudePassthrough],
  });
}

main().catch((err) => { console.error(err.message); process.exit(1); });
