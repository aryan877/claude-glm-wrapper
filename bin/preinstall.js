#!/usr/bin/env node

/**
 * Preinstall script — allow npx and global installs, block local dependency installs.
 *
 * Global installs are needed so users can run ccx, claude-codex, claude-gemini as bins.
 * Local `npm install claude-proxy-ai` as a dependency is still blocked.
 */

// Check if being installed as a dependency vs run via npx
const isNpxInstall = process.env.npm_execpath && process.env.npm_execpath.includes('npx');
const isTempInstall = process.env.npm_config_cache && process.cwd().includes('_npx');
const isGlobalInstall = process.env.npm_config_global === 'true' ||
                        process.argv.includes('-g') ||
                        process.argv.includes('--global');

// Allow local development
const isLocalDev = process.cwd().includes('claude-proxy') ||
                   process.cwd().includes('claude-glm-wrapper') ||
                   process.env.CLAUDE_PROXY_DEV === 'true' ||
                   process.env.CLAUDE_GLM_DEV === 'true';
if (isLocalDev) process.exit(0);

// Allow npx and global installs
if (isNpxInstall || isTempInstall || isGlobalInstall) {
  process.exit(0);
}

// Block local dependency installs
console.error('\n❌ ERROR: Incorrect installation method!\n');
console.error('✅ Correct usage:');
console.error('   npx claude-proxy-ai              # Interactive GLM installer');
console.error('   npm install -g claude-proxy-ai    # Global install (ccx, claude-codex, claude-gemini)\n');
console.error('❌ Do NOT install as a local dependency:');
console.error('   npm install claude-proxy-ai\n');

process.exit(1);
