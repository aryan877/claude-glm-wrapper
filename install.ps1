# Claude Proxy PowerShell Installer for Windows
# Works without admin rights, installs to user's profile directory
#
# Usage:
#   iwr -useb https://raw.githubusercontent.com/aryan877/claude-proxy/main/install.ps1 | iex
#   .\install.ps1

# Configuration
$UserBinDir = "$env:USERPROFILE\.local\bin"
$ZaiApiKey = "YOUR_ZAI_API_KEY_HERE"

# ── Helpers ──────────────────────────────────────────────────────────

function Find-AllInstallations {
    $locations = @(
        "$env:USERPROFILE\.local\bin",
        "$env:ProgramFiles\Claude-GLM",
        "$env:LOCALAPPDATA\Programs\claude-glm",
        "C:\Program Files\Claude-GLM"
    )
    $foundFiles = @()
    foreach ($location in $locations) {
        if (Test-Path $location) {
            try {
                $files = Get-ChildItem -Path $location -Filter "claude-glm*.ps1" -ErrorAction Stop
                foreach ($file in $files) { $foundFiles += $file.FullName }
            } catch {}
        }
    }
    return $foundFiles
}

function Remove-OldWrappers {
    $allWrappers = Find-AllInstallations
    if ($allWrappers.Count -eq 0) { return }

    $oldWrappers = @()
    $currentWrappers = @()
    foreach ($wrapper in $allWrappers) {
        if ($wrapper -like "$UserBinDir*") { $currentWrappers += $wrapper }
        else { $oldWrappers += $wrapper }
    }

    if ($oldWrappers.Count -eq 0) { return }

    Write-Host ""
    Write-Host "Found existing wrappers in multiple locations:"
    Write-Host ""
    foreach ($wrapper in $oldWrappers) { Write-Host "  OLD: $wrapper" }
    foreach ($wrapper in $currentWrappers) { Write-Host "  OK:  $wrapper" }

    Write-Host ""
    $cleanupChoice = Read-Host "Clean up old installations? (y/n)"
    if ($cleanupChoice -eq "y" -or $cleanupChoice -eq "Y") {
        foreach ($wrapper in $oldWrappers) {
            try {
                Remove-Item -Path $wrapper -Force -ErrorAction Stop
                Write-Host "  Removed: $wrapper"
            } catch {
                Write-Host "  Could not remove: $wrapper"
            }
        }
        Write-Host "Cleanup complete!"
    }
    Write-Host ""
}

function Setup-UserBin {
    if (-not (Test-Path $UserBinDir)) {
        New-Item -ItemType Directory -Path $UserBinDir -Force | Out-Null
    }
    $currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($currentPath -notlike "*$UserBinDir*") {
        Write-Host "Adding $UserBinDir to PATH..."
        $newPath = if ($currentPath) { "$currentPath;$UserBinDir" } else { $UserBinDir }
        [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
        $env:PATH = "$env:PATH;$UserBinDir"
        Write-Host "PATH updated. Restart PowerShell for it to take effect."
        Write-Host ""
    }
}

function Test-ClaudeInstallation {
    Write-Host "Checking Claude Code installation..."
    if (Get-Command claude -ErrorAction SilentlyContinue) {
        $claudePath = (Get-Command claude).Source
        Write-Host "Claude Code found at: $claudePath"
        return $true
    } else {
        Write-Host "Claude Code not found in PATH"
        Write-Host ""
        Write-Host "Options:"
        Write-Host "1. Add Claude Code to PATH first"
        Write-Host "2. Install from: https://www.anthropic.com/claude-code"
        Write-Host "3. Continue anyway"
        Write-Host ""
        $continue = Read-Host "Continue? (y/n)"
        if ($continue -ne "y" -and $continue -ne "Y") {
            Write-Host "Installation cancelled."
            exit 1
        }
        return $false
    }
}

function Add-PowerShellAliases {
    if (-not (Test-Path $PROFILE)) {
        $profileDir = Split-Path $PROFILE
        if (-not (Test-Path $profileDir)) {
            New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
        }
        New-Item -ItemType File -Path $PROFILE -Force | Out-Null
    }

    $profileContent = @()
    if (Test-Path $PROFILE) {
        try { $profileContent = Get-Content $PROFILE -ErrorAction Stop } catch { $profileContent = @() }
    }

    # Remove old aliases (including legacy ccg45/ccf)
    $filteredContent = $profileContent | Where-Object {
        $_ -notmatch "# Claude Code Model Switcher Aliases" -and
        $_ -notmatch "Set-Alias cc " -and
        $_ -notmatch "Set-Alias ccg " -and
        $_ -notmatch "Set-Alias ccg45 " -and
        $_ -notmatch "Set-Alias ccf "
    }

    $aliases = @"

# Claude Code Model Switcher Aliases
Set-Alias cc claude
Set-Alias ccg claude-glm
"@

    $newContent = $filteredContent + $aliases
    Set-Content -Path $PROFILE -Value $newContent
    Write-Host "Added aliases to PowerShell profile: $PROFILE"
}

# ── Wrapper creator ──────────────────────────────────────────────────

# Creates the claude-glm.ps1 wrapper script
function New-ClaudeGlmWrapper {
    $wrapperPath = Join-Path $UserBinDir "claude-glm.ps1"
    $configDir = "$env:USERPROFILE\.claude-glm"

    $wrapperContent = @(
        '# claude-glm - Claude Code with Z.AI GLM-5',
        '#',
        '# Change ANTHROPIC_MODEL below to use a different model:',
        '#   glm-5, glm-4.5, glm-4.5-air, glm-4-flash',
        '',
        '$env:ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic"',
        "`$env:ANTHROPIC_AUTH_TOKEN = `"$ZaiApiKey`"",
        '$env:ANTHROPIC_MODEL = "glm-5"',
        '$env:ANTHROPIC_SMALL_FAST_MODEL = "glm-4.5-air"',
        "`$env:CLAUDE_HOME = `"$configDir`"",
        '',
        'if (-not (Test-Path $env:CLAUDE_HOME)) {',
        '    New-Item -ItemType Directory -Path $env:CLAUDE_HOME -Force | Out-Null',
        '}',
        '',
        "`$settingsJson = '{`"env`":{`"ANTHROPIC_BASE_URL`":`"https://api.z.ai/api/anthropic`",`"ANTHROPIC_AUTH_TOKEN`":`"$ZaiApiKey`",`"ANTHROPIC_MODEL`":`"glm-5`",`"ANTHROPIC_SMALL_FAST_MODEL`":`"glm-4.5-air`"}}'",
        'Set-Content -Path (Join-Path $env:CLAUDE_HOME "settings.json") -Value $settingsJson',
        '',
        'Write-Host "Starting Claude Code with GLM-5..."',
        'Write-Host "Config directory: $env:CLAUDE_HOME"',
        "Write-Host `"To change model, edit: $wrapperPath`"",
        'Write-Host ""',
        '',
        'if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {',
        '    Write-Host "ERROR: ''claude'' command not found!"',
        '    Write-Host "Please ensure Claude Code is installed and in your PATH"',
        '    exit 1',
        '}',
        '',
        '& claude $args'
    ) -join "`n"

    Set-Content -Path $wrapperPath -Value $wrapperContent
    Write-Host "Installed claude-glm at $wrapperPath" -ForegroundColor Green
}

# ── Error reporting ──────────────────────────────────────────────────

function Report-Error {
    param(
        [string]$ErrorMessage,
        [string]$ErrorLine = "",
        [object]$ErrorRecord = $null
    )

    Write-Host ""
    Write-Host "=============================================" -ForegroundColor Red
    Write-Host "Installation failed!" -ForegroundColor Red
    Write-Host "=============================================" -ForegroundColor Red
    Write-Host ""

    $sanitizedError = $ErrorMessage -replace 'ANTHROPIC_AUTH_TOKEN\s*=\s*\S+', 'ANTHROPIC_AUTH_TOKEN=[REDACTED]'
    $sanitizedError = $sanitizedError -replace 'ZaiApiKey\s*=\s*\S+', 'ZaiApiKey=[REDACTED]'

    Write-Host "Error: $sanitizedError"
    if ($ErrorLine) { Write-Host "Location: $ErrorLine" }
    Write-Host ""

    $reportChoice = Read-Host "Report this error to GitHub? (y/n)"
    if ($reportChoice -ne "y" -and $reportChoice -ne "Y") {
        Write-Host "Get help at: https://github.com/aryan877/claude-proxy/issues"
        return
    }

    $issueUrl = "https://github.com/aryan877/claude-proxy/issues/new?labels=bug,windows,installation"
    try { Start-Process $issueUrl -ErrorAction Stop }
    catch { Write-Host "Open this URL to report: $issueUrl" }
}

# ── Main ─────────────────────────────────────────────────────────────

function Install-ClaudeGlm {
    Write-Host "Claude Proxy PowerShell Installer for Windows"
    Write-Host "=============================================="
    Write-Host ""
    Write-Host "This installer:"
    Write-Host "  - Does NOT require administrator rights"
    Write-Host "  - Installs to: $UserBinDir"
    Write-Host ""

    Test-ClaudeInstallation
    Setup-UserBin
    Remove-OldWrappers

    # Check if already installed
    $glmWrapper = Join-Path $UserBinDir "claude-glm.ps1"

    if (Test-Path $glmWrapper) {
        Write-Host ""
        Write-Host "Existing installation detected!"
        Write-Host "1. Update API key only"
        Write-Host "2. Reinstall everything"
        Write-Host "3. Cancel"
        $choice = Read-Host "Choice (1-3)"

        switch ($choice) {
            "1" {
                $inputKey = Read-Host "Enter your Z.AI API key"
                if ($inputKey) {
                    $script:ZaiApiKey = $inputKey
                    New-ClaudeGlmWrapper
                    Write-Host "API key updated!"
                    exit 0
                }
            }
            "2" { Write-Host "Reinstalling..." }
            default { exit 0 }
        }
    }

    # Get API key
    Write-Host ""
    Write-Host "Enter your Z.AI API key (from https://z.ai/manage-apikey/apikey-list)"
    $inputKey = Read-Host "API Key"

    if ($inputKey) {
        $script:ZaiApiKey = $inputKey
        Write-Host "API key received ($($inputKey.Length) characters)"
    } else {
        Write-Host "No API key provided. Add it manually later."
    }

    # Create wrapper and aliases
    New-ClaudeGlmWrapper
    Add-PowerShellAliases

    # Final instructions
    Write-Host ""
    Write-Host "Installation complete!"
    Write-Host ""
    Write-Host "=========================================="
    Write-Host "Restart PowerShell or reload profile:"
    Write-Host "=========================================="
    Write-Host ""
    Write-Host "   . `$PROFILE"
    Write-Host ""
    Write-Host "=========================================="
    Write-Host ""
    Write-Host "Commands:"
    Write-Host "   claude-glm  - Claude Code with GLM-5"
    Write-Host ""
    Write-Host "Aliases:"
    Write-Host "   cc   - claude (regular Claude)"
    Write-Host "   ccg  - claude-glm (GLM-5)"
    Write-Host ""
    Write-Host "For multi-provider proxy (ccx, claude-codex, claude-gemini):"
    Write-Host "   npm install -g claude-proxy-ai"
    Write-Host ""
    Write-Host "To change model, edit: $UserBinDir\claude-glm.ps1"
    Write-Host "   Available: glm-5, glm-4.5, glm-4.5-air, glm-4-flash"
    Write-Host ""

    if ($ZaiApiKey -eq "YOUR_ZAI_API_KEY_HERE") {
        Write-Host "Don't forget to add your API key to: $UserBinDir\claude-glm.ps1"
    }

    Write-Host "Installation location: $UserBinDir"
    Write-Host "Config directory: ~/.claude-glm"
}

# Run installation with error handling
try {
    $ErrorActionPreference = "Stop"
    Install-ClaudeGlm
} catch {
    $errorMessage = $_.Exception.Message
    $errorLine = if ($_.InvocationInfo.ScriptLineNumber) {
        "Line $($_.InvocationInfo.ScriptLineNumber) in $($_.InvocationInfo.ScriptName)"
    } else { "Unknown location" }

    Report-Error -ErrorMessage $errorMessage -ErrorLine $errorLine -ErrorRecord $_

    Write-Host ""
    Write-Host "Installation terminated due to error." -ForegroundColor Red
}
