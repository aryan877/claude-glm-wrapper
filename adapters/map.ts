// Provider parsing and message mapping utilities
import {
  AnthropicMessage,
  AnthropicRequest,
  ProviderKey,
  ProviderModel,
} from "./types.js";

const PROVIDER_PREFIXES: ProviderKey[] = [
  "openai",
  "openrouter",
  "gemini",
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
  // Claude shortcuts (for API users)
  opus: "anthropic:claude-opus-4-5-20251101",
  sonnet: "anthropic:claude-sonnet-4-5-20250929",
  haiku: "anthropic:claude-haiku-4-5-20251001",
  // Add more shortcuts as needed
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

  // Expand shortcuts first
  const expanded = MODEL_SHORTCUTS[modelField.toLowerCase()] || modelField;

  // Auto-detect Claude models (start with "claude-") and route to anthropic
  if (expanded.toLowerCase().startsWith("claude-")) {
    return { provider: "anthropic", model: expanded };
  }

  const sep = expanded.includes(":")
    ? ":"
    : expanded.includes("/")
      ? "/"
      : null;
  if (!sep) {
    // no prefix: fall back to defaults or assume glm as legacy
    return defaults ?? { provider: "glm", model: expanded };
  }

  const [maybeProv, ...rest] = expanded.split(sep);
  const prov = maybeProv.toLowerCase() as ProviderKey;

  if (!PROVIDER_PREFIXES.includes(prov)) {
    // unrecognized prefix -> use defaults or treat full string as model
    return defaults ?? { provider: "glm", model: expanded };
  }

  return { provider: prov, model: rest.join(sep) };
}

/**
 * Warn if tools are being used with providers that may not support them
 */
export function warnIfTools(
  req: AnthropicRequest,
  provider: ProviderKey,
): void {
  if (req.tools && req.tools.length > 0) {
    // Only GLM and Anthropic support tools natively
    if (provider !== "glm" && provider !== "anthropic") {
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
