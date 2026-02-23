#!/bin/bash
# Claude Proxy Server-Friendly Installer
# Works without sudo, installs to user's home directory
#
# Usage:
#   bash <(curl -fsSL https://raw.githubusercontent.com/aryan877/claude-proxy/main/install.sh)
#   ./install.sh

# Configuration
USER_BIN_DIR="$HOME/.local/bin"
ZAI_API_KEY="YOUR_ZAI_API_KEY_HERE"

# ── Helpers ──────────────────────────────────────────────────────────

# Detect the user's primary shell rc file.
#
# A user CAN have multiple rc files (e.g. both ~/.bashrc and ~/.bash_profile),
# but we only write to ONE — the one their shell actually sources on startup.
#
# Why pick just one?
#   - Writing to multiple would cause duplicate PATH entries and aliases
#   - Each shell has a clear "primary" config that always gets sourced:
#       bash interactive: ~/.bashrc  (but macOS Terminal sources ~/.bash_profile instead)
#       zsh:              ~/.zshrc   (always sourced for interactive shells)
#       ksh:              ~/.kshrc   (but falls back to ~/.profile on some systems)
#
# The $SHELL env var tells us which shell the user has set as their login shell,
# NOT which shell is running this script (this script always runs in bash via #!/bin/bash).
detect_shell_rc() {
    # Extract just the shell name: "/bin/zsh" → "zsh", "/usr/local/bin/bash" → "bash"
    local shell_name=$(basename "$SHELL")
    local rc_file=""

    case "$shell_name" in
        bash)
            # Default to .bashrc (sourced by interactive non-login shells)
            rc_file="$HOME/.bashrc"
            # But if .bash_profile exists, prefer it — macOS Terminal opens login shells,
            # which source .bash_profile but NOT .bashrc (unless .bash_profile sources it)
            [ -f "$HOME/.bash_profile" ] && rc_file="$HOME/.bash_profile"
            ;;
        zsh)
            # .zshrc is sourced by every interactive zsh shell (login or not)
            rc_file="$HOME/.zshrc"
            ;;
        ksh)
            rc_file="$HOME/.kshrc"
            # Some ksh setups only source .profile (especially on older systems)
            [ -f "$HOME/.profile" ] && rc_file="$HOME/.profile"
            ;;
        csh|tcsh)
            rc_file="$HOME/.cshrc"
            ;;
        *)
            # Unknown shell — .profile is the POSIX standard fallback
            rc_file="$HOME/.profile"
            ;;
    esac

    # Return the path by printing it (caller captures with $(...))
    echo "$rc_file"
}

# Ensure user bin directory exists and is in PATH
setup_user_bin() {
    # Create ~/.local/bin if it doesn't exist (-p = no error if already there)
    mkdir -p "$USER_BIN_DIR"

    # Detect which shell config file to modify (~/.zshrc, ~/.bashrc, etc.)
    local rc_file=$(detect_shell_rc)

    # Check if $USER_BIN_DIR is already in PATH.
    # PATH is colon-delimited: "/usr/bin:/usr/local/bin:/home/user/.local/bin"
    # We wrap both sides with ":" so the pattern match requires exact segment boundaries:
    #   ":$PATH:"          → ":/usr/bin:/usr/local/bin:"   (adds delimiters at edges)
    #   ":$USER_BIN_DIR:"  → ":/home/user/.local/bin:"     (what we're looking for)
    # Without wrapping, "/home/user/.local/bin2" would falsely match "/home/user/.local/bin"
    if [[ ":$PATH:" != *":$USER_BIN_DIR:"* ]]; then
        echo "📝 Adding $USER_BIN_DIR to PATH in $rc_file"

        # csh/tcsh uses "setenv VAR value" syntax instead of "export VAR=value"
        if [[ "$rc_file" == *".cshrc" ]]; then
            # Appends: setenv PATH $PATH:/home/user/.local/bin
            # \$PATH is escaped so the literal string "$PATH" is written to the file
            # (it will be expanded when the user's shell sources .cshrc later)
            echo "setenv PATH \$PATH:$USER_BIN_DIR" >> "$rc_file"
        else
            # Appends: export PATH="$PATH:/home/user/.local/bin"
            # \$PATH → writes literal "$PATH" into the file (expanded at source-time)
            # \"     → writes literal quotes into the file (protects paths with spaces)
            # $USER_BIN_DIR is expanded NOW to bake in the actual directory path
            echo "export PATH=\"\$PATH:$USER_BIN_DIR\"" >> "$rc_file"
        fi

        # Remind user to reload — the PATH change only takes effect in new shells
        # or after manually sourcing the rc file
        echo ""
        echo "⚠️  IMPORTANT: You will need to run this command after installation:"
        echo "   source $rc_file"
        echo ""
    fi
}

# Find all existing wrapper installations
find_all_installations() {
    local locations=("/usr/local/bin" "/usr/bin" "$HOME/.local/bin" "$HOME/bin")
    local found_files=()
    for location in "${locations[@]}"; do
        if [ -d "$location" ]; then
            while IFS= read -r file; do
                [ -f "$file" ] && found_files+=("$file")
            done < <(find "$location" -maxdepth 1 -name "claude-glm*" 2>/dev/null)
        fi
    done
    printf '%s\n' "${found_files[@]}"
}

# Clean up old wrapper installations
cleanup_old_wrappers() {
    local all_wrappers=($(find_all_installations))
    [ ${#all_wrappers[@]} -eq 0 ] && return 0

    local old_wrappers=()
    local current_wrappers=()
    for wrapper in "${all_wrappers[@]}"; do
        if [[ "$wrapper" == "$USER_BIN_DIR"* ]]; then
            current_wrappers+=("$wrapper")
        else
            old_wrappers+=("$wrapper")
        fi
    done

    [ ${#old_wrappers[@]} -eq 0 ] && return 0

    echo ""
    echo "🔍 Found existing wrappers in multiple locations:"
    echo ""
    for wrapper in "${old_wrappers[@]}"; do
        echo "  ❌ $wrapper (old location)"
    done
    for wrapper in "${current_wrappers[@]}"; do
        echo "  ✅ $wrapper (current location)"
    done

    echo ""
    read -p "Would you like to clean up old installations? (y/n): " cleanup_choice
    if [[ "$cleanup_choice" == "y" || "$cleanup_choice" == "Y" ]]; then
        echo ""
        for wrapper in "${old_wrappers[@]}"; do
            if rm "$wrapper" 2>/dev/null; then
                echo "  ✅ Removed: $wrapper"
            else
                echo "  ⚠️  Could not remove: $wrapper (permission denied)"
            fi
        done
        echo ""
        echo "✅ Cleanup complete!"
    else
        echo ""
        echo "⚠️  Skipping cleanup. Old wrappers may interfere with the new installation."
    fi
    echo ""
}

# Check Claude Code availability
check_claude_installation() {
    echo "🔍 Checking Claude Code installation..."
    if command -v claude &> /dev/null; then
        echo "✅ Claude Code found at: $(which claude)"
        return 0
    else
        echo "⚠️  Claude Code not found in PATH"
        echo ""
        echo "Options:"
        echo "1. If Claude Code is installed elsewhere, add it to PATH first"
        echo "2. Install Claude Code from: https://www.anthropic.com/claude-code"
        echo "3. Continue anyway (wrappers will be created but won't work until claude is available)"
        echo ""
        read -p "Continue with installation? (y/n): " continue_choice
        if [[ "$continue_choice" != "y" && "$continue_choice" != "Y" ]]; then
            echo "Installation cancelled."
            exit 1
        fi
        return 1
    fi
}

# ── Wrapper creator ──────────────────────────────────────────────────

# Creates the claude-glm wrapper script at $USER_BIN_DIR/claude-glm
create_claude_glm_wrapper() {
    local wrapper_path="$USER_BIN_DIR/claude-glm"

    cat > "$wrapper_path" << EOF
#!/bin/bash
# claude-glm - Claude Code with Z.AI GLM-5
#
# Change ANTHROPIC_MODEL below to use a different model:
#   glm-5, glm-4.5, glm-4.5-air, glm-4-flash

export ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
export ANTHROPIC_AUTH_TOKEN="$ZAI_API_KEY"
export ANTHROPIC_MODEL="glm-5"
export ANTHROPIC_SMALL_FAST_MODEL="glm-4.5-air"
export CLAUDE_HOME="\$HOME/.claude-glm"

mkdir -p "\$CLAUDE_HOME"

cat > "\$CLAUDE_HOME/settings.json" << SETTINGS
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "$ZAI_API_KEY",
    "ANTHROPIC_MODEL": "glm-5",
    "ANTHROPIC_SMALL_FAST_MODEL": "glm-4.5-air"
  }
}
SETTINGS

echo "🚀 Starting Claude Code with GLM-5..."
echo "📁 Config directory: \$CLAUDE_HOME"
echo "💡 To change model, edit: $wrapper_path"
echo ""

if ! command -v claude &> /dev/null; then
    echo "❌ Error: 'claude' command not found!"
    echo "Please ensure Claude Code is installed and in your PATH"
    exit 1
fi

claude "\$@"
EOF

    chmod +x "$wrapper_path"
    echo "✅ Installed claude-glm at $wrapper_path"
}

# Create shell aliases
create_shell_aliases() {
    local rc_file=$(detect_shell_rc)

    if [ -z "$rc_file" ] || [ ! -f "$rc_file" ]; then
        echo "⚠️  Could not detect shell rc file, skipping aliases"
        return
    fi

    # Remove old aliases if they exist (including legacy ccg45/ccf)
    if grep -q "# Claude Code Model Switcher Aliases" "$rc_file" 2>/dev/null; then
        grep -v "# Claude Code Model Switcher Aliases" "$rc_file" | \
        grep -v "alias cc=" | \
        grep -v "alias ccg=" | \
        grep -v "alias ccg45=" | \
        grep -v "alias ccf=" | \
        grep -v "alias claude-d=" | \
        grep -v "alias claude-glm-d=" > "$rc_file.tmp"
        mv "$rc_file.tmp" "$rc_file"
    fi

    if [[ "$rc_file" == *".cshrc" ]]; then
        cat >> "$rc_file" << 'EOF'

# Claude Code Model Switcher Aliases
alias cc 'claude'
alias ccg 'claude-glm'
alias claude-d 'claude --dangerously-skip-permissions'
alias claude-glm-d 'claude-glm --dangerously-skip-permissions'
EOF
    else
        cat >> "$rc_file" << 'EOF'

# Claude Code Model Switcher Aliases
alias cc='claude'
alias ccg='claude-glm'
alias claude-d='claude --dangerously-skip-permissions'
alias claude-glm-d='claude-glm --dangerously-skip-permissions'
EOF
    fi

    echo "✅ Added aliases to $rc_file"
}

# ── Error reporting ──────────────────────────────────────────────────

report_error() {
    local error_msg="$1"
    local error_line="$2"
    local error_code="$3"

    echo ""
    echo "============================================="
    echo "❌ Installation failed!"
    echo "============================================="
    echo ""

    # Sanitize (remove API keys)
    local sanitized=$(echo "$error_msg" | sed \
        -e 's/ANTHROPIC_AUTH_TOKEN="[^"]*"/ANTHROPIC_AUTH_TOKEN="[REDACTED]"/g' \
        -e 's/ZAI_API_KEY="[^"]*"/ZAI_API_KEY="[REDACTED]"/g')

    echo "Error: $sanitized"
    [ -n "$error_line" ] && echo "Location: $error_line"
    echo ""

    read -p "Report this error to GitHub? (y/n): " report_choice
    if [ "$report_choice" != "y" ] && [ "$report_choice" != "Y" ]; then
        echo "Get help at: https://github.com/aryan877/claude-proxy/issues"
        return
    fi

    local issue_url="https://github.com/aryan877/claude-proxy/issues/new?labels=bug,unix,installation"

    if command -v open &> /dev/null; then
        open "$issue_url" 2>/dev/null
    elif command -v xdg-open &> /dev/null; then
        xdg-open "$issue_url" 2>/dev/null
    else
        echo "Open this URL to report: $issue_url"
    fi
}

# ── Main ─────────────────────────────────────────────────────────────

main() {
    echo "🔧 Claude Proxy Server-Friendly Installer"
    echo "=========================================="
    echo ""
    echo "This installer:"
    echo "  • Does NOT require sudo/root access"
    echo "  • Installs to: $USER_BIN_DIR"
    echo "  • Works on Unix/Linux servers"
    echo ""

    check_claude_installation
    setup_user_bin
    cleanup_old_wrappers

    # Check if already installed
    if [ -f "$USER_BIN_DIR/claude-glm" ]; then
        echo ""
        echo "✅ Existing installation detected!"
        echo "1) Update API key only"
        echo "2) Reinstall everything"
        echo "3) Cancel"
        read -p "Choice (1-3): " update_choice

        case "$update_choice" in
            1)
                read -p "Enter your Z.AI API key: " input_key
                if [ -n "$input_key" ]; then
                    ZAI_API_KEY="$input_key"
                    create_claude_glm_wrapper
                    echo "✅ API key updated!"
                    exit 0
                fi
                ;;
            2) echo "Reinstalling..." ;;
            *) exit 0 ;;
        esac
    fi

    # Get API key
    echo ""
    echo "Enter your Z.AI API key (from https://z.ai/manage-apikey/apikey-list)"
    read -p "API Key: " input_key

    if [ -n "$input_key" ]; then
        ZAI_API_KEY="$input_key"
        echo "✅ API key received (${#input_key} characters)"
    else
        echo "⚠️  No API key provided. Add it manually later."
    fi

    # Create wrapper and aliases
    create_claude_glm_wrapper
    create_shell_aliases

    # Final instructions
    local rc_file=$(detect_shell_rc)

    echo ""
    echo "✅ Installation complete!"
    echo ""
    echo "=========================================="
    echo "⚡ IMPORTANT: Run this command now:"
    echo "=========================================="
    echo ""
    echo "   source $rc_file"
    echo ""
    echo "=========================================="
    echo ""
    echo "📝 After sourcing, you can use:"
    echo ""
    echo "Commands:"
    echo "   claude-glm      - Claude Code with GLM-5"
    echo ""
    echo "Aliases:"
    echo "   cc          - claude (regular Claude)"
    echo "   ccg         - claude-glm (GLM-5)"
    echo "   claude-d    - claude --dangerously-skip-permissions"
    echo "   claude-glm-d - claude-glm --dangerously-skip-permissions"
    echo ""
    echo "📦 For multi-provider proxy (ccx, claude-codex, claude-gemini):"
    echo "   npm install -g claude-proxy-ai"
    echo ""
    echo "💡 To change model, edit: $USER_BIN_DIR/claude-glm"
    echo "   Available: glm-5, glm-4.5, glm-4.5-air, glm-4-flash"
    echo ""

    if [ "$ZAI_API_KEY" = "YOUR_ZAI_API_KEY_HERE" ]; then
        echo "⚠️  Don't forget to add your API key to: $USER_BIN_DIR/claude-glm"
    fi

    echo "📁 Installation location: $USER_BIN_DIR"
    echo "📁 Config directory: ~/.claude-glm"
}

# Error handler
handle_error() {
    local exit_code=$?
    local line_number=$1
    local bash_command="$2"

    local error_msg="Command failed with exit code $exit_code"
    [ -n "$bash_command" ] && error_msg="$error_msg: $bash_command"

    report_error "$error_msg" "Line $line_number in install.sh" "$exit_code"
    echo ""
    echo "Installation terminated due to error."
}

# Set up error handling and run
set -eE
trap 'handle_error ${LINENO} "$BASH_COMMAND"' ERR
main "$@"
