#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const platform = os.platform();
const rootDir = path.join(__dirname, '..');

console.log('🔧 Claude Proxy Cross-Platform Installer');
console.log('==========================================\n');
console.log(`Detected OS: ${platform}\n`);

function runInstaller() {
  let command, args, scriptPath;

  if (platform === 'win32') {
    // Windows - run PowerShell installer
    console.log('🪟 Running Windows PowerShell installer...\n');
    scriptPath = path.join(rootDir, 'install.ps1');

    if (!fs.existsSync(scriptPath)) {
      console.error('❌ Error: install.ps1 not found!');
      process.exit(1);
    }

    command = 'powershell.exe';
    args = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath
    ];

  } else if (platform === 'darwin' || platform === 'linux') {
    // macOS or Linux - run bash installer
    console.log(`🐧 Running Unix/Linux installer...\n`);
    scriptPath = path.join(rootDir, 'install.sh');

    if (!fs.existsSync(scriptPath)) {
      console.error('❌ Error: install.sh not found!');
      process.exit(1);
    }

    command = 'bash';
    args = [scriptPath];

  } else {
    console.error(`❌ Unsupported platform: ${platform}`);
    console.error('This installer supports Windows, macOS, and Linux.');
    process.exit(1);
  }

  // Spawn the installer process
  const installer = spawn(command, args, {
    stdio: 'inherit',
    cwd: rootDir
  });

  installer.on('error', (error) => {
    console.error(`❌ Failed to start installer: ${error.message}`);
    process.exit(1);
  });

  installer.on('close', (code) => {
    if (code !== 0) {
      console.error(`\n❌ Installer exited with code ${code}`);
      process.exit(code);
    }
    console.log('\n✅ Installation completed successfully!');
  });
}

// Run the installer
runInstaller();
