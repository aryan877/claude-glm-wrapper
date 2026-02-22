// OpenRouter adapter (OpenAI-compatible API) with full tool calling support
import { FastifyReply } from "fastify";
import { createParser } from "eventsource-parser";
import type { EventSourceMessage } from "eventsource-parser";
import { sendEvent } from "../sse.js";
import type { AnthropicRequest, AnthropicMessage, AnthropicTool, AnthropicContentBlock } from "../types.js";

const OR_BASE = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

// ── Format converters: Anthropic → OpenAI ──────────────────────────────

/** Convert Anthropic tools to OpenAI tools format */
function toOpenAITools(tools: AnthropicTool[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema ?? { type: "object", properties: {} },
    },
  }));
}

/** Convert Anthropic messages (with tool_use/tool_result) to OpenAI messages */
function toOpenAIMessagesWithTools(messages: AnthropicMessage[]) {
  const out: any[] = [];

  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    // Complex content blocks - need to split into separate messages
    const textParts: string[] = [];
    const toolCalls: any[] = [];
    const toolResults: any[] = [];

    for (const block of m.content as AnthropicContentBlock[]) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input),
          },
        });
      } else if (block.type === "tool_result") {
        const content = typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content);
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content,
        });
      }
    }

    // Assistant message with tool calls
    if (m.role === "assistant" && toolCalls.length > 0) {
      out.push({
        role: "assistant",
        content: textParts.join("") || null,
        tool_calls: toolCalls,
      });
    } else if (textParts.length > 0) {
      out.push({ role: m.role, content: textParts.join("") });
    }

    // Tool results become separate "tool" role messages
    for (const tr of toolResults) {
      out.push(tr);
    }
  }

  return out;
}

// ── Main adapter ────────────────────────────────────────────────────────

export async function chatOpenRouter(
  res: FastifyReply,
  body: AnthropicRequest,
  model: string,
  apiKey?: string
) {
  if (!apiKey) {
    throw withStatus(401, "Missing OPENROUTER_API_KEY. Set it in ~/.claude-proxy/.env");
  }

  const url = `${OR_BASE}/chat/completions`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  if (process.env.OPENROUTER_REFERER) {
    headers["HTTP-Referer"] = process.env.OPENROUTER_REFERER;
  }
  if (process.env.OPENROUTER_TITLE) {
    headers["X-Title"] = process.env.OPENROUTER_TITLE;
  }

  // Build OpenAI-format request
  const hasTools = body.tools && body.tools.length > 0;
  const messages = hasTools
    ? toOpenAIMessagesWithTools(body.messages)
    : toOpenAIMessagesWithTools(body.messages);

  // Add system message if present
  if (body.system) {
    messages.unshift({ role: "system", content: body.system });
  }

  const reqBody: any = {
    model,
    messages,
    stream: true,
    temperature: body.temperature ?? 0.7,
    max_tokens: body.max_tokens,
  };

  if (hasTools) {
    reqBody.tools = toOpenAITools(body.tools!);
    console.log(`[openrouter] Sending ${body.tools!.length} tools (converted to OpenAI format)`);
  }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(reqBody),
  });

  if (!resp.ok || !resp.body) {
    const text = await safeText(resp);
    throw withStatus(resp.status || 500, `OpenRouter error: ${text}`);
  }

  // ── Stream response and convert back to Anthropic SSE format ──────

  const msgId = `msg_${Date.now()}`;
  let contentIndex = 0;
  let hasStartedMessage = false;
  let hasStartedThinking = false;
  let hasStartedContent = false;

  // Accumulate tool calls from streaming chunks
  const pendingToolCalls: Record<number, { id: string; name: string; arguments: string }> = {};

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
      // Close thinking block first if open
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
      if (!data || data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        const choice = json.choices?.[0];
        if (!choice) return;

        const delta = choice.delta;
        if (!delta) return;

        // Handle reasoning/thinking tokens (GLM-5 and other reasoning models)
        const reasoningChunk = delta.reasoning || "";
        if (reasoningChunk) {
          ensureThinkingBlockStarted();
          sendEvent(res, "content_block_delta", {
            type: "content_block_delta",
            index: contentIndex,
            delta: { type: "thinking_delta", thinking: reasoningChunk },
          });
        }

        // Handle text content
        const textChunk = delta.content || "";
        if (textChunk) {
          ensureContentBlockStarted();
          sendEvent(res, "content_block_delta", {
            type: "content_block_delta",
            index: contentIndex,
            delta: { type: "text_delta", text: textChunk },
          });
        }

        // Handle streaming tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!pendingToolCalls[idx]) {
              pendingToolCalls[idx] = { id: "", name: "", arguments: "" };
            }
            if (tc.id) pendingToolCalls[idx].id = tc.id;
            if (tc.function?.name) pendingToolCalls[idx].name += tc.function.name;
            if (tc.function?.arguments) pendingToolCalls[idx].arguments += tc.function.arguments;
          }
        }
      } catch {
        // ignore parse errors
      }
    },
  });

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value));
  }

  // ── Finalize: emit tool_use blocks if any ─────────────────────────

  ensureMessageStarted();

  // Close any open blocks
  closeThinkingBlock();
  closeContentBlock();

  // Emit tool_use content blocks
  const toolCallEntries = Object.values(pendingToolCalls);
  if (toolCallEntries.length > 0) {
    for (const tc of toolCallEntries) {
      // Start tool_use content block
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

      // Send the input as a delta
      sendEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: contentIndex,
        delta: {
          type: "input_json_delta",
          partial_json: tc.arguments,
        },
      });

      // Stop tool_use content block
      sendEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index: contentIndex,
      });

      contentIndex++;
    }
  }

  // Determine stop reason
  const stopReason = toolCallEntries.length > 0 ? "tool_use" : "end_turn";

  // Send message_delta and message_stop
  sendEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 0 },
  });
  sendEvent(res, "message_stop", { type: "message_stop" });

  res.raw.end();
}

function withStatus(status: number, message: string) {
  const e = new Error(message);
  // @ts-ignore
  e.statusCode = status;
  return e;
}

async function safeText(resp: Response) {
  try {
    return await resp.text();
  } catch {
    return "<no-body>";
  }
}
