// Gemini OAuth adapter - uses Google OAuth tokens with Code Assist API or standard Generative Language API
// Supports full tool/function calling and streaming

import { FastifyReply } from "fastify";
import { createParser } from "eventsource-parser";
import type { EventSourceMessage } from "eventsource-parser";
import { sendEvent } from "../sse.js";
import { getAccessToken, loadTokens } from "../google-auth.js";
import type {
  AnthropicRequest,
  AnthropicMessage,
  AnthropicTool,
  AnthropicContentBlock,
} from "../types.js";
import * as crypto from "crypto";

// ── Endpoints ──────────────────────────────────────────────────────────

const CA_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const CA_VERSION = "v1internal";
const GL_ENDPOINT =
  process.env.GEMINI_BASE_URL ||
  "https://generativelanguage.googleapis.com/v1beta";

// ── Format converters: Anthropic → Gemini ──────────────────────────────

/** Find tool name by tool_use_id in message history */
function findToolName(messages: AnthropicMessage[], toolUseId: string): string {
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const block of m.content as AnthropicContentBlock[]) {
      if (block.type === "tool_use" && block.id === toolUseId) {
        return block.name;
      }
    }
  }
  return "unknown_tool";
}

/** Convert Anthropic content blocks to Gemini parts */
function toGeminiParts(
  content: AnthropicMessage["content"],
  allMessages: AnthropicMessage[]
): any[] {
  if (typeof content === "string") {
    return content ? [{ text: content }] : [{ text: " " }];
  }

  const parts: any[] = [];
  for (const block of content as AnthropicContentBlock[]) {
    if (block.type === "text") {
      if (block.text) parts.push({ text: block.text });
    } else if (block.type === "image") {
      parts.push({
        inlineData: {
          mimeType: block.source.media_type,
          data: block.source.data,
        },
      });
    } else if (block.type === "tool_use") {
      parts.push({
        functionCall: {
          name: block.name,
          args:
            typeof block.input === "string"
              ? JSON.parse(block.input)
              : block.input,
        },
        thoughtSignature: "skip_thought_signature_validator",
      });
    } else if (block.type === "tool_result") {
      const functionName = findToolName(allMessages, block.tool_use_id);
      const resultContent =
        typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content);
      parts.push({
        functionResponse: {
          name: functionName,
          response: { content: resultContent },
        },
      });
    }
  }

  return parts.length > 0 ? parts : [{ text: " " }];
}

/** Convert Anthropic messages to Gemini contents array */
function toGeminiContents(messages: AnthropicMessage[]) {
  // Gemini requires alternating user/model roles
  // Merge consecutive same-role messages
  const merged: { role: string; parts: any[] }[] = [];

  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const parts = toGeminiParts(m.content, messages);

    if (merged.length > 0 && merged[merged.length - 1].role === role) {
      // Merge into previous message of same role
      merged[merged.length - 1].parts.push(...parts);
    } else {
      merged.push({ role, parts });
    }
  }

  return merged;
}

/** Whitelist of fields Gemini actually accepts in function declaration schemas */
const GEMINI_ALLOWED = new Set([
  "type", "properties", "required", "description",
  "enum", "items", "format", "nullable", "title",
  "anyOf", "$ref", "$defs", "$id", "$anchor",
  "minimum", "maximum", "minItems", "maxItems",
  "prefixItems", "additionalProperties", "propertyOrdering",
]);

/** Recursively strip JSON Schema fields Gemini doesn't support.
 *  `isPropertyMap` = true when we're inside a "properties" object,
 *  where keys are user-defined property names (not schema keywords). */
function sanitizeSchema(obj: any, isPropertyMap = false): any {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((v) => sanitizeSchema(v, false));

  const clean: any = {};
  for (const [key, val] of Object.entries(obj)) {
    if (!isPropertyMap && !GEMINI_ALLOWED.has(key)) continue;
    // When key is "properties", its value is a map of name→schema
    clean[key] = sanitizeSchema(val, key === "properties");
  }
  return clean;
}

/** Convert Anthropic tools to Gemini function declarations */
function toGeminiTools(tools: AnthropicTool[]) {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description || "",
        parameters: sanitizeSchema(t.input_schema) || { type: "object", properties: {} },
      })),
    },
  ];
}

// ── Main adapter ────────────────────────────────────────────────────────

import type { ReasoningLevel } from "../types.js";

export async function chatGeminiOAuth(
  res: FastifyReply,
  body: AnthropicRequest,
  model: string,
  apiKey?: string,
  reasoning?: ReasoningLevel
) {
  // Helper to send error as SSE (since headers are already flushed by the gateway)
  function sendSSEError(msg: string) {
    try {
      const id = `msg_${Date.now()}`;
      res.raw.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
      res.raw.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
      res.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `[Gemini OAuth Error] ${msg}` } })}\n\n`);
      res.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
      res.raw.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`);
      res.raw.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    } catch { /* stream closed */ }
    try { res.raw.end(); } catch {}
  }

  try {
    return await _chatGeminiOAuthInner(res, body, model, apiKey, reasoning as ReasoningLevel | undefined);
  } catch (e: any) {
    console.error(`[gemini-oauth] ERROR: ${e.message}`);
    sendSSEError(e.message);
  }
}

async function _chatGeminiOAuthInner(
  res: FastifyReply,
  body: AnthropicRequest,
  model: string,
  apiKey?: string,
  reasoning?: ReasoningLevel
) {
  // If API key provided, use it directly (no OAuth needed)
  // Otherwise use OAuth access token (auto-refreshes if expired)
  const accessToken = apiKey || await getAccessToken();
  const tokens = apiKey ? null : await loadTokens();
  const projectId = tokens?.project_id;

  // Build Gemini request
  const contents = toGeminiContents(body.messages);

  // Detect Gemini 3 vs 2.5 models for thinking config
  const isGemini3 = /^gemini-3(\.|-|$)/.test(model);

  // gemini-3-pro-preview only supports LOW and HIGH (no MEDIUM/MINIMAL)
  // gemini-3.1-pro-preview, gemini-3-flash-preview, gemini-3.1-flash-preview support MINIMAL/LOW/MEDIUM/HIGH
  const isLimitedThinking = model === "gemini-3-pro-preview";

  // Build thinking config based on model family
  // Gemini 3: uses thinkingLevel (LOW/MEDIUM/HIGH)
  // Gemini 2.5: uses thinkingBudget (number of tokens)
  let thinkingConfig: any;
  if (isGemini3) {
    let thinkingLevel: string;
    if (isLimitedThinking) {
      // gemini-3-pro-preview: only LOW and HIGH
      const LIMITED_LEVELS: Record<string, string> = { low: "LOW", medium: "HIGH", high: "HIGH", xhigh: "HIGH" };
      thinkingLevel = LIMITED_LEVELS[reasoning || ""] || "HIGH";
      if (reasoning === "medium") {
        console.log(`[gemini] Note: ${model} doesn't support MEDIUM, using HIGH instead`);
      }
    } else {
      // 3.1-pro, 3-flash, 3.1-flash: full range
      const THINKING_LEVELS: Record<string, string> = { low: "LOW", medium: "MEDIUM", high: "HIGH", xhigh: "HIGH" };
      thinkingLevel = THINKING_LEVELS[reasoning || ""] || "HIGH";
    }
    thinkingConfig = { includeThoughts: true, thinkingLevel };
    console.log(`[gemini] Gemini 3 model: thinkingLevel=${thinkingLevel}${reasoning ? ` (${reasoning})` : ""}`);
  } else {
    const THINKING_BUDGETS: Record<string, number> = { low: 1024, medium: 8192, high: 32768, xhigh: 65536 };
    const thinkingBudget = THINKING_BUDGETS[reasoning || ""] || THINKING_BUDGETS.high;
    thinkingConfig = { includeThoughts: true, thinkingBudget };
    if (reasoning) {
      console.log(`[gemini] Gemini 2.5 model: thinkingBudget=${thinkingBudget} (${reasoning})`);
    }
  }

  const generationConfig: any = {
    temperature: body.temperature ?? 1,
    topP: 0.95,
    topK: 64,
    thinkingConfig,
  };
  if (body.max_tokens !== undefined) {
    generationConfig.maxOutputTokens = body.max_tokens;
  }

  // Tools: function declarations + Google Search grounding
  const tools: any[] = [];
  if (body.tools && body.tools.length > 0) {
    tools.push(...toGeminiTools(body.tools));
    console.log(
      `[gemini] Sending ${body.tools.length} tools as Gemini function declarations`
    );
  }
  // Add Google Search grounding tool
  tools.push({ google_search: {} });
  console.log(`[gemini] Google Search grounding enabled`);

  let url: string;
  let reqBody: any;

  if (projectId) {
    // Code Assist API - systemInstruction has a different protobuf schema,
    // so prepend system prompt to first user message instead
    if (body.system) {
      const sysText = Array.isArray(body.system)
        ? (body.system as any[]).map((b: any) => b.text ?? "").join("\n")
        : body.system;
      if (contents.length > 0 && contents[0].role === "user") {
        contents[0].parts.unshift({ text: `[System Instructions]\n${sysText}\n[End System Instructions]\n\n` });
      } else {
        contents.unshift({
          role: "user",
          parts: [{ text: `[System Instructions]\n${sysText}\n[End System Instructions]` }],
        });
      }
    }

    url = `${CA_ENDPOINT}/${CA_VERSION}:streamGenerateContent?alt=sse`;
    reqBody = {
      model,
      project: projectId,
      user_prompt_id: crypto.randomUUID(),
      request: {
        contents,
        generationConfig,
        tools,
      },
    };
    console.log(
      `[gemini-oauth] Code Assist API | model="${model}" project="${projectId}"`
    );
  } else {
    // Standard Generative Language API - systemInstruction works natively
    const sysTextStd = Array.isArray(body.system)
      ? (body.system as any[]).map((b: any) => b.text ?? "").join("\n")
      : body.system;
    const systemInstruction = sysTextStd
      ? { role: "user", parts: [{ text: sysTextStd }] }
      : undefined;

    url = `${GL_ENDPOINT}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    // API key auth appends key to URL instead of using Bearer token
    if (apiKey) {
      url += `&key=${apiKey}`;
    }
    reqBody = {
      contents,
      ...(systemInstruction && { systemInstruction }),
      generationConfig,
      tools,
    };
    console.log(`[gemini] Standard API | model="${model}" auth=${apiKey ? "api-key" : "oauth"}`);
  }

  // Log outgoing request for debugging
  const reqJson = JSON.stringify(reqBody);
  console.log(`[gemini] REQUEST URL: ${url.replace(/key=[^&]+/, "key=***")}`);
  console.log(`[gemini] REQUEST BODY (${reqJson.length} bytes): ${reqJson.slice(0, 500)}...`);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  // Only add Bearer auth when using OAuth (not API key)
  if (!apiKey) {
    headers["Authorization"] = `Bearer ${accessToken}`;
    headers["User-Agent"] = "google-api-nodejs-client/9.15.1";
    headers["X-Goog-Api-Client"] = "gl-node/22.17.0";
    headers["Client-Metadata"] = "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI";
  }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: reqJson,
  });

  if (!resp.ok || !resp.body) {
    const text = await safeText(resp);
    console.error(`[gemini-oauth] API error ${resp.status}: ${text}`);
    throw new Error(`Gemini API returned ${resp.status}: ${text.slice(0, 300)}`);
  }

  // ── Stream response and convert to Anthropic SSE format ──────────────

  const msgId = `msg_${Date.now()}`;
  let contentIndex = 0;
  let hasStartedMessage = false;
  let hasStartedThinking = false;
  let hasStartedContent = false;

  // Accumulate function calls from streaming chunks
  const pendingToolCalls: { id: string; name: string; args: any }[] = [];

  function ensureMessageStarted() {
    if (!hasStartedMessage) {
      hasStartedMessage = true;
      sendEvent(res, "message_start", {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }
  }

  function ensureThinkingBlockStarted() {
    if (!hasStartedThinking) {
      hasStartedThinking = true;
      ensureMessageStarted();
      sendEvent(res, "content_block_start", {
        type: "content_block_start",
        index: contentIndex,
        content_block: { type: "thinking", thinking: "" },
      });
    }
  }

  function closeThinkingBlock() {
    if (hasStartedThinking) {
      sendEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index: contentIndex,
      });
      contentIndex++;
      hasStartedThinking = false;
    }
  }

  function ensureContentBlockStarted() {
    if (!hasStartedContent) {
      closeThinkingBlock();
      hasStartedContent = true;
      ensureMessageStarted();
      sendEvent(res, "content_block_start", {
        type: "content_block_start",
        index: contentIndex,
        content_block: { type: "text", text: "" },
      });
    }
  }

  function closeContentBlock() {
    if (hasStartedContent) {
      sendEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index: contentIndex,
      });
      contentIndex++;
      hasStartedContent = false;
    }
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      const data = event.data;
      if (!data) return;
      try {
        const json = JSON.parse(data);

        // Handle both Code Assist (wrapped) and standard API (unwrapped) responses
        const candidateData = json.response || json;
        const candidate = candidateData?.candidates?.[0];
        if (!candidate?.content?.parts) return;

        for (const part of candidate.content.parts) {
          // Handle thinking/reasoning (Gemini 2.5+ models)
          if (part.thought === true && part.text) {
            ensureThinkingBlockStarted();
            sendEvent(res, "content_block_delta", {
              type: "content_block_delta",
              index: contentIndex,
              delta: { type: "thinking_delta", thinking: part.text },
            });
          }
          // Handle regular text
          else if (part.text && part.thought !== true) {
            ensureContentBlockStarted();
            sendEvent(res, "content_block_delta", {
              type: "content_block_delta",
              index: contentIndex,
              delta: { type: "text_delta", text: part.text },
            });
          }

          // Handle function calls
          if (part.functionCall) {
            pendingToolCalls.push({
              id: `toolu_${crypto.randomBytes(12).toString("hex")}`,
              name: part.functionCall.name,
              args: part.functionCall.args || {},
            });
          }
        }
      } catch {
        // ignore parse errors in SSE stream
      }
    },
  });

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value, { stream: true }));
  }

  // ── Finalize: close blocks and emit tool_use if any ──────────────────

  ensureMessageStarted();
  closeThinkingBlock();
  closeContentBlock();

  // Emit tool_use content blocks
  if (pendingToolCalls.length > 0) {
    for (const tc of pendingToolCalls) {
      sendEvent(res, "content_block_start", {
        type: "content_block_start",
        index: contentIndex,
        content_block: {
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: {},
        },
      });

      sendEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: contentIndex,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(tc.args),
        },
      });

      sendEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index: contentIndex,
      });

      contentIndex++;
    }
  }

  // Stop reason
  const stopReason = pendingToolCalls.length > 0 ? "tool_use" : "end_turn";

  sendEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 0 },
  });
  sendEvent(res, "message_stop", { type: "message_stop" });

  res.raw.end();
}

// ── Helpers ────────────────────────────────────────────────────────────

async function safeText(resp: Response) {
  try {
    return await resp.text();
  } catch {
    return "<no-body>";
  }
}
