# Claude Proxy

Use **any AI model** with [Claude Code](https://www.anthropic.com/claude-code) — GPT-5.3, Gemini 3 Pro, GLM-5, and more.

A local proxy that translates between Claude Code's Anthropic API format and multiple AI providers. Switch models mid-session with `/model`.

## Supported Providers

| Provider | Auth Method | Models |
|----------|------------|--------|
| **OpenAI Codex** | OAuth (ChatGPT Plus subscription) | GPT-5.3-Codex, GPT-5.2-Codex, GPT-5.1-Codex-Max/Mini |
| **Google Gemini** | OAuth (Google account) | Gemini 3/3.1 Pro, Gemini 3 Flash, Gemini 2.5 Pro/Flash |
| **Z.AI GLM** | API key | GLM-5, GLM-4.7, GLM-4.5, GLM-4-Flash |
| **OpenRouter** | API key | Hundreds of models |
| **Anthropic** | API key | Claude Opus, Sonnet, Haiku (passthrough) |

## Quick Start

### Option 1: `claude-codex` (GPT-5.3 via ChatGPT Plus)

No API key needed — uses your ChatGPT Plus subscription via OAuth.

```bash
# Install
npm install -g claude-proxy-ai

# Run
claude-codex
```

On first run, the proxy starts and launches Claude Code with GPT-5.3-Codex as the default model. If you haven't logged in yet, visit the URL shown to authenticate with your OpenAI account.

### Option 2: `claude-gemini` (Gemini 3 Pro via Google account)

No API key needed — uses Google OAuth with Code Assist API.

```bash
claude-gemini
```

### Option 3: `npx claude-proxy-ai` (GLM installer)

For Z.AI GLM models with an API key:

```bash
npx claude-proxy-ai
```

This runs the interactive installer that sets up wrapper scripts and shell aliases.

## Commands

| Command | Default Model | Auth |
|---------|--------------|------|
| `claude-codex` | GPT-5.3-Codex | OpenAI OAuth (ChatGPT Plus) |
| `claude-codex-d` | GPT-5.3-Codex | Same, with `--dangerously-skip-permissions` |
| `claude-gemini` | Gemini 3 Pro | Google OAuth |
| `claude-gemini-d` | Gemini 3 Pro | Same, with `--dangerously-skip-permissions` |
| `ccx` | Configurable | API keys in `.env` |
| `ccg` / `claude-glm` | GLM-4.7 | Z.AI API key |
| `ccf` | GLM-4.5-Air | Z.AI API key |
| `claude-glm-d` | GLM-4.7 | Same, with `--dangerously-skip-permissions` |
| `cc` | Claude (native) | Anthropic subscription |
| `claude-d` | Claude (native) | Same, with `--dangerously-skip-permissions` |

### Command Flags

All launcher commands support these flags:

```bash
claude-codex -d                  # Dangerously skip permissions
claude-codex --restart           # Force restart the proxy
claude-codex --stop              # Stop the proxy
claude-codex --status            # Show auth status
claude-codex --logout            # Clear saved tokens
claude-codex --proxy-status      # Show proxy status
```

## Switching Models

Use Claude Code's `/model` command. The proxy intercepts it and routes to the right provider.

### Model Shortcuts

Instead of typing `provider:full-model-name`, use shortcuts:

```
/model codex          → gpt-5.3-codex (default Codex)
/model codex-5.3      → gpt-5.3-codex
/model codex-5.2      → gpt-5.2-codex
/model codex-max      → gpt-5.1-codex-max
/model codex-mini     → gpt-5.1-codex-mini
/model cx             → gpt-5.3-codex (short alias)

/model gemini         → gemini-3-pro-preview (default Gemini)
/model gemini-pro     → gemini-3-pro-preview
/model gemini-flash   → gemini-3-flash-preview
/model gemini-31p     → gemini-3.1-pro-preview (standard API only)
/model gemini-31f     → gemini-3.1-flash-preview (standard API only)
/model gemini-25p     → gemini-2.5-pro
/model gemini-25f     → gemini-2.5-flash
/model gp             → gemini-3-pro-preview (short alias)
/model gf             → gemini-3-flash-preview (short alias)

/model glm            → glm-5
/model glm5           → glm-5
/model glm47          → glm-4.7
/model glm45          → glm-4.5
/model g              → glm-5 (short alias)
/model flash          → glm-4-flash

/model opus           → claude-opus-4-5
/model sonnet         → claude-sonnet-4-5
/model haiku          → claude-haiku-4-5
```

You can also use the full `provider:model` format: `/model codex-oauth:gpt-5.3-codex`

### Reasoning Levels

Append `@level` to any model to control reasoning effort:

```
/model codex@low       Low reasoning
/model codex@medium    Medium reasoning
/model codex@high      High reasoning (default)
/model codex@xhigh     Extra High reasoning

/model gemini@low      Minimal thinking
/model gemini@medium   Moderate thinking
/model gemini@high     Full thinking (default)

/model gemini-25p@low      1K token thinking budget
/model gemini-25p@medium   8K token thinking budget
/model gemini-25p@high     32K token thinking budget
/model gemini-25p@xhigh    65K token thinking budget
```

**Examples:**
```
/model codex-5.2@low
/model codex@xhigh
/model gemini-flash@medium
```

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│  Your Machine                                                    │
│                                                                  │
│  ┌─────────────┐      ┌──────────────────────────┐              │
│  │ Claude Code │ ──── │ Local Proxy (:17870)     │              │
│  │             │      │ Translates Anthropic API │              │
│  │ Thinks it's │      │ to each provider's       │              │
│  │ talking to  │      │ native format            │              │
│  │ Anthropic   │      └────────┬─────────────────┘              │
│  └─────────────┘               │                                 │
│                    ┌───────────┼───────────┬──────────┐          │
└────────────────────┼───────────┼───────────┼──────────┼──────────┘
                     ▼           ▼           ▼          ▼
              ┌──────────┐ ┌──────────┐ ┌────────┐ ┌────────┐
              │  OpenAI  │ │  Google  │ │  Z.AI  │ │ OpenR. │
              │  Codex   │ │  Gemini  │ │  GLM   │ │        │
              │ (OAuth)  │ │ (OAuth)  │ │ (key)  │ │ (key)  │
              └──────────┘ └──────────┘ └────────┘ └────────┘
```

The proxy handles:
- **Format translation**: Converts Anthropic messages ↔ OpenAI Responses API / Gemini API / etc.
- **Streaming**: Translates each provider's SSE format to Anthropic SSE events
- **Tool calling**: MCP tools (Read, Edit, Bash, etc.) work with all providers
- **Thinking/Reasoning**: Maps reasoning levels to each provider's native format
- **Web search**: Codex models get server-side web search automatically
- **Images**: Vision support via base64 encoding or text description fallback

## Authentication

### OpenAI Codex (OAuth)

Uses your ChatGPT Plus/Pro subscription. No API key needed.

**Option A: Use Codex CLI tokens** (recommended)

If you have [Codex CLI](https://github.com/openai/codex) installed and logged in, the proxy automatically finds your tokens at `~/.codex/auth.json`.

```bash
# Install Codex CLI and log in
npm install -g @openai/codex
codex --login

# Then just run
claude-codex
```

**Option B: Browser login**

```bash
claude-codex
# If no tokens found, visit: http://127.0.0.1:17870/codex/login
```

### Google Gemini (OAuth)

Uses your Google account with the Code Assist API (free tier available).

```bash
claude-gemini
# On first run, visit: http://127.0.0.1:17870/google/login
```

### API Keys (GLM, OpenRouter, Anthropic)

For providers that use API keys, configure `~/.claude-proxy/.env`:

```bash
# Z.AI GLM
GLM_UPSTREAM_URL=https://api.z.ai/api/anthropic
ZAI_API_KEY=your-key

# OpenRouter
OPENROUTER_API_KEY=sk-or-...

# Anthropic (passthrough)
ANTHROPIC_UPSTREAM_URL=https://api.anthropic.com
ANTHROPIC_API_KEY=sk-ant-...
```

## Features

### Tool Calling

All Claude Code tools work with every provider:
- **MCP tools** (Read, Edit, Bash, Glob, Grep, etc.) — executed locally by Claude Code
- **Web search** — executed server-side by OpenAI (Codex models only, automatic)

The proxy converts Anthropic's `tool_use`/`tool_result` format to each provider's native tool calling format and back.

### Reasoning / Thinking

All reasoning-capable models stream their thinking process:

| Provider | How Reasoning Works |
|----------|-------------------|
| Codex (GPT-5.x) | `reasoning.effort`: low/medium/high/xhigh |
| Gemini 3 Pro | `thinkingLevel`: LOW/HIGH only (medium → HIGH) |
| Gemini 3.1 Pro, 3 Flash | `thinkingLevel`: LOW/MEDIUM/HIGH |
| Gemini 2.5 | `thinkingBudget`: token count |

Thinking tokens appear as `thinking` blocks in Claude Code, just like native Claude extended thinking.

### Vision

Send images to models that support vision. The proxy passes base64 images to providers that support them (Gemini, OpenAI) and falls back to generating text descriptions for providers that don't (GLM).

## File Structure

```
~/.claude-proxy/
├── .env                    # API keys
├── adapters/               # Provider adapters (TypeScript)
│   ├── anthropic-gateway.ts  # Main proxy server
│   ├── map.ts               # Model shortcuts & routing
│   ├── types.ts             # Shared types
│   ├── openai-auth.ts       # Codex OAuth
│   ├── google-auth.ts       # Google OAuth
│   └── providers/
│       ├── codex-oauth.ts    # OpenAI Codex (Responses API)
│       ├── gemini-oauth.ts   # Google Gemini
│       ├── openrouter.ts     # OpenRouter
│       └── anthropic-pass.ts # Anthropic passthrough
├── bin/
│   ├── claude-codex.js       # Codex launcher
│   ├── claude-gemini.js      # Gemini launcher
│   └── lib/
│       └── proxy-launcher.js # Proxy lifecycle management
├── google-oauth.json       # Google tokens (auto-generated)
├── codex-oauth.json        # Codex tokens (auto-generated)
├── proxy.pid               # PID lock file
└── proxy.log               # Proxy output log
```

## Adding Custom Shortcuts

Edit `~/.claude-proxy/adapters/map.ts` and add to the `MODEL_SHORTCUTS` object:

```typescript
const MODEL_SHORTCUTS: Record<string, string> = {
  // Your custom shortcuts
  "my-model": "openrouter:some-org/some-model",
  // ...existing shortcuts
};
```

Then restart the proxy (`claude-codex --restart`).

## Troubleshooting

### Proxy won't start

```bash
# Check if port is in use
lsof -ti:17870

# Force restart
claude-codex --restart

# Check logs
cat ~/.claude-proxy/proxy.log
```

### OAuth token expired

Tokens auto-refresh. If they don't:

```bash
# Codex
claude-codex --logout
claude-codex

# Gemini
claude-gemini --logout
claude-gemini
```

### Models not switching

Make sure you're using the right format: `/model shortcut` or `/model provider:model-name`

Check the proxy log for routing info:
```bash
tail -f ~/.claude-proxy/proxy.log
```

### Tool calls not working

The proxy converts tool calls between formats. If a provider doesn't support function calling, tool calls will fail. All major providers (Codex, Gemini, GLM) support tool calling.

## Development

```bash
# Clone
git clone https://github.com/aryan877/claude-proxy.git
cd claude-proxy

# Install deps
npm install

# Run proxy in dev mode
npm run start:proxy

# Run tests
npm test
```

## License

MIT — see [LICENSE](LICENSE).
