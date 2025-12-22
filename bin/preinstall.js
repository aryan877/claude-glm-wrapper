#!/usr/bin/env node

/**
 * Preinstall script to prevent incorrect installation method
 * This package should ONLY be run with npx, not installed
 */

// Check if being installed as a dependency vs run via npx
// When using npx, npm sets npm_execpath to npx or the install is in a temp directory
const isNpxInstall = process.env.npm_execpath && process.env.npm_execpath.includes('npx');
const isTempInstall = process.env.npm_config_cache && process.cwd().includes('_npx');

// Allow local development
const isLocalDev = process.cwd().includes('claude-glm-wrapper') ||
                   process.env.CLAUDE_GLM_DEV === 'true';
if (isLocalDev) process.exit(0);

// Block ALL installation attempts (local and global)
if (!isNpxInstall && !isTempInstall) {
  console.error('\n❌ ERROR: Incorrect installation method!\n');
  console.error('This package is meant to be run directly with npx only.\n');
  console.error('✅ Correct usage:');
  console.error('   npx claude-glm-installer\n');
  console.error('❌ Do NOT install this package:');
  console.error('   npm install claude-glm-installer');
  console.error('   npm i claude-glm-installer');
  console.error('   npm install -g claude-glm-installer\n');
  console.error('Always use npx to run the latest version!\n');

  process.exit(1);
}

// Allow installation to proceed only for npx
process.exit(0);
