// Provider parsing and message mapping utilities
import {
  AnthropicMessage,
  AnthropicRequest,
  ProviderKey,
  ProviderModel,
  ReasoningLevel,
} from "./types.js";

const VALID_REASONING: ReasoningLevel[] = ["low", "medium", "high", "xhigh"];

const PROVIDER_PREFIXES: ProviderKey[] = [
  "openai",
  "openrouter",
  "gemini",
  "gemini-oauth",
  "codex-oauth",
  "glm",
  "anthropic",
];

// Model shortcuts - add your own aliases here
const MODEL_SHORTCUTS: Record<string, string> = {
  // GLM shortcuts
  g: "glm:glm-5",
  glm: "glm:glm-5",
  glm47: "glm:glm-4.7",
  glm45: "glm:glm-4.5",
  glm5: "glm:glm-5",
  glm5or: "openrouter:z-ai/glm-5",
  flash: "glm:glm-4-flash",
  // MiniMax shortcuts
  minimax: "openrouter:minimax/minimax-m2.5",
  mm: "openrouter:minimax/minimax-m2.5",
  m25: "openrouter:minimax/minimax-m2.5",
  // Claude shortcuts (for API users)
  opus: "anthropic:claude-opus-4-5-20251101",
  sonnet: "anthropic:claude-sonnet-4-5-20250929",
  haiku: "anthropic:claude-haiku-4-5-20251001",
  // Gemini OAuth shortcuts (Google account login)
  gemini: "gemini-oauth:gemini-3-pro-preview",
  "gemini-pro": "gemini-oauth:gemini-3-pro-preview",
  "gemini-flash": "gemini-oauth:gemini-3-flash-preview",
  "gemini-31p": "gemini-oauth:gemini-3.1-pro-preview",
  "gemini-31f": "gemini-oauth:gemini-3.1-flash-preview",
  "gemini-25p": "gemini-oauth:gemini-2.5-pro",
  "gemini-25f": "gemini-oauth:gemini-2.5-flash",
  gp: "gemini-oauth:gemini-3-pro-preview",
  gf: "gemini-oauth:gemini-3-flash-preview",
  // Codex OAuth shortcuts (OpenAI ChatGPT Plus subscription)
  codex: "codex-oauth:gpt-5.3-codex",
  "codex-5.3": "codex-oauth:gpt-5.3-codex",
  "codex-5.2": "codex-oauth:gpt-5.2-codex",
  "codex-max": "codex-oauth:gpt-5.1-codex-max",
  "codex-mini": "codex-oauth:gpt-5.1-codex-mini",
  "gpt52": "codex-oauth:gpt-5.2",
  cx: "codex-oauth:gpt-5.3-codex",
  cx53: "codex-oauth:gpt-5.3-codex",
  cx52: "codex-oauth:gpt-5.2-codex",
};

/**
 * Parse provider and model from the model field
 * Supports formats: "provider:model" or "provider/model"
 * Falls back to defaults if no valid prefix found
 */
export function parseProviderModel(
  modelField: string,
  defaults?: ProviderModel,
): ProviderModel {
  if (!modelField) {
    if (defaults) return defaults;
    throw new Error("Missing 'model' in request");
  }

  // Extract @reasoning suffix (e.g. "codex@high", "gemini@low")
  let reasoning: ReasoningLevel | undefined;
  let rawField = modelField;
  const atIdx = modelField.lastIndexOf("@");
  if (atIdx > 0) {
    const suffix = modelField.slice(atIdx + 1).toLowerCase() as ReasoningLevel;
    if (VALID_REASONING.includes(suffix)) {
      reasoning = suffix;
      rawField = modelField.slice(0, atIdx);
    }
  }

  // Expand shortcuts first
  const expanded = MODEL_SHORTCUTS[rawField.toLowerCase()] || rawField;

  // Auto-detect Claude models (start with "claude-") and route to anthropic
  if (expanded.toLowerCase().startsWith("claude-")) {
    return { provider: "anthropic", model: expanded, reasoning };
  }

  // Auto-detect GLM models (start with "glm-") and route to glm
  if (expanded.toLowerCase().startsWith("glm-")) {
    return { provider: "glm", model: expanded, reasoning };
  }

  const sep = expanded.includes(":")
    ? ":"
    : expanded.includes("/")
      ? "/"
      : null;
  if (!sep) {
    const base = defaults ?? { provider: "glm" as ProviderKey, model: expanded };
    return { ...base, reasoning: reasoning ?? base.reasoning };
  }

  const [maybeProv, ...rest] = expanded.split(sep);
  const prov = maybeProv.toLowerCase() as ProviderKey;

  if (!PROVIDER_PREFIXES.includes(prov)) {
    const base = defaults ?? { provider: "glm" as ProviderKey, model: expanded };
    return { ...base, reasoning: reasoning ?? base.reasoning };
  }

  return { provider: prov, model: rest.join(sep), reasoning };
}

/**
 * Warn if tools are being used with providers that may not support them
 */
export function warnIfTools(
  req: AnthropicRequest,
  provider: ProviderKey,
): void {
  if (req.tools && req.tools.length > 0) {
    // GLM, Anthropic, Gemini OAuth, and Codex OAuth support tools natively
    if (provider !== "glm" && provider !== "anthropic" && provider !== "gemini-oauth" && provider !== "codex-oauth") {
      console.warn(
        `[proxy] Warning: ${provider} may not fully support Anthropic-style tools. Passing through anyway.`,
      );
    }
  }
}

/**
 * Convert Anthropic content to plain text
 */
export function toPlainText(content: AnthropicMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((c) => {
      if (typeof c === "string") return c;
      if (c.type === "text") return c.text;
      if (c.type === "tool_result") {
        // Convert tool results to text representation
        if (typeof c.content === "string") return c.content;
        return JSON.stringify(c.content);
      }
      return "";
    })
    .join("");
}

/**
 * Convert Anthropic messages to OpenAI format
 */
export function toOpenAIMessages(messages: AnthropicMessage[]) {
  return messages.map((m) => ({
    role: m.role,
    content: toPlainText(m.content),
  }));
}

/**
 * Convert Anthropic messages to Gemini format
 */
export function toGeminiContents(messages: AnthropicMessage[]) {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: toPlainText(m.content) }],
  }));
}
