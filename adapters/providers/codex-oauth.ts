// Codex OAuth adapter - uses OpenAI OAuth tokens with Responses API
// Supports tool calling, reasoning, web search, and streaming
// Uses /v1/responses (NOT /v1/chat/completions) as required by Codex CLI OAuth tokens

import type { EventSourceMessage } from "eventsource-parser";
import { createParser } from "eventsource-parser";
import { FastifyReply } from "fastify";
import { getCodexAccessToken, getCodexAccountId } from "../openai-auth.js";
import { sendEvent } from "../sse.js";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicTool,
  ReasoningLevel,
} from "../types.js";

const OPENAI_API_BASE = "https://api.openai.com/v1";
const CHATGPT_CODEX_BASE = "https://chatgpt.com/backend-api/codex";

// ── Format converters: Anthropic → OpenAI Responses API ──────────────

/** Convert Anthropic tools to Responses API tool format */
function toResponsesTools(tools: AnthropicTool[]) {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description ?? "",
    parameters: t.input_schema ?? { type: "object", properties: {} },
  }));
}

/** Convert Anthropic messages to Responses API input items */
function toResponsesInput(messages: AnthropicMessage[]): any[] {
  const items: any[] = [];

  for (const m of messages) {
    if (typeof m.content === "string") {
      items.push({
        type: "message",
        role: m.role === "assistant" ? "assistant" : "user",
        content: [
          {
            type: m.role === "assistant" ? "output_text" : "input_text",
            text: m.content,
          },
        ],
      });
      continue;
    }

    // Collect parts for this message
    const contentParts: any[] = [];
    const functionCalls: any[] = [];
    const functionOutputs: any[] = [];

    for (const block of m.content as AnthropicContentBlock[]) {
      if (block.type === "text") {
        const textType = m.role === "assistant" ? "output_text" : "input_text";
        contentParts.push({ type: textType, text: block.text });
      } else if (block.type === "tool_use") {
        // Function calls are separate items in Responses API
        functionCalls.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments:
            typeof block.input === "string"
              ? block.input
              : JSON.stringify(block.input),
        });
      } else if (block.type === "tool_result") {
        const output =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content);
        functionOutputs.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output,
        });
      } else if (block.type === "image") {
        contentParts.push({
          type: "input_image",
          image_url: `data:${block.source.media_type};base64,${block.source.data}`,
        });
      }
    }

    // Add message with content parts
    if (contentParts.length > 0) {
      items.push({
        type: "message",
        role: m.role === "assistant" ? "assistant" : "user",
        content: contentParts,
      });
    }

    // Add function calls as separate items
    for (const fc of functionCalls) {
      items.push(fc);
    }

    // Add function outputs as separate items
    for (const fo of functionOutputs) {
      items.push(fo);
    }
  }

  return items;
}

// ── Main adapter ──────────────────────────────────────────────────────

export async function chatCodexOAuth(
  res: FastifyReply,
  body: AnthropicRequest,
  model: string,
  apiKey?: string,
  reasoning?: ReasoningLevel,
) {
  function sendSSEError(msg: string) {
    try {
      const id = `msg_${Date.now()}`;
      res.raw.write(
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`,
      );
      res.raw.write(
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
      );
      res.raw.write(
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `[Codex OAuth Error] ${msg}` } })}\n\n`,
      );
      res.raw.write(
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      );
      res.raw.write(
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`,
      );
      res.raw.write(
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      );
    } catch {
      /* stream closed */
    }
    try {
      res.raw.end();
    } catch {}
  }

  try {
    return await _chatCodexOAuthInner(res, body, model, apiKey, reasoning);
  } catch (e: any) {
    console.error(`[codex] ERROR: ${e.message}`);
    sendSSEError(e.message);
  }
}

async function _chatCodexOAuthInner(
  res: FastifyReply,
  body: AnthropicRequest,
  model: string,
  apiKey?: string,
  reasoning?: ReasoningLevel,
) {
  const accessToken = apiKey || (await getCodexAccessToken());

  // OAuth tokens use ChatGPT backend (Responses API), API keys use standard API
  const isOAuth = !apiKey;
  const url = isOAuth
    ? `${CHATGPT_CODEX_BASE}/responses`
    : `${OPENAI_API_BASE}/chat/completions`;

  const hasTools = body.tools && body.tools.length > 0;

  // Reasoning effort
  const EFFORT_MAP: Record<string, string> = {
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
  };
  const reasoningEffort =
    EFFORT_MAP[reasoning || ""] || process.env.CODEX_REASONING_EFFORT || "high";

  let reqBody: any;

  if (isOAuth) {
    // ── Responses API format ──
    const input = toResponsesInput(body.messages);
    const tools: any[] = hasTools ? toResponsesTools(body.tools!) : [];

    // Add web search tool (ChatGPT backend uses "web_search")
    tools.push({ type: "web_search" });

    // system can be a string or array of {type:"text",text:"..."} objects
    const instructions = Array.isArray(body.system)
      ? (body.system as any[]).map((b: any) => b.text ?? "").join("\n")
      : (body.system || "");

    reqBody = {
      model,
      instructions,
      input,
      tools,
      stream: true,
      store: false, // Required by ChatGPT backend
      reasoning: { effort: reasoningEffort, summary: "auto" },
    };
    // Note: ChatGPT backend does NOT support max_output_tokens

    console.log(
      `[codex] Responses API | model="${model}" input_items=${input.length} tools=${tools.length} reasoning=${reasoningEffort} web_search=on`,
    );
  } else {
    // ── Chat Completions API (for API key users) ──
    const messages = toOpenAIMessagesFromAnthropic(body.messages);
    if (body.system) {
      const sysText = Array.isArray(body.system)
        ? (body.system as any[]).map((b: any) => b.text ?? "").join("\n")
        : body.system;
      messages.unshift({ role: "system", content: sysText });
    }

    reqBody = {
      model,
      messages,
      stream: true,
      temperature: body.temperature ?? 0.7,
      max_tokens: body.max_tokens,
      web_search_options: { search_context_size: "medium" },
    };

    if (hasTools) {
      reqBody.tools = body.tools!.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: t.input_schema ?? { type: "object", properties: {} },
        },
      }));
    }

    if (
      model.includes("codex") ||
      model.includes("gpt-5") ||
      model.includes("o3") ||
      model.includes("o4")
    ) {
      reqBody.reasoning_effort = reasoningEffort;
    }

    console.log(
      `[codex] Chat Completions | model="${model}" messages=${messages.length} tools=${hasTools ? body.tools!.length : 0}`,
    );
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  if (isOAuth) {
    // ChatGPT backend requires these headers (matches Codex CLI behavior)
    headers["originator"] = "codex_cli_rs";
    headers["User-Agent"] =
      `codex_cli_rs/0.1.0 (${process.platform}; ${process.arch})`;
    headers["Accept"] = "text/event-stream";
    // ChatGPT-Account-ID is required for routing to the correct workspace
    const accountId = getCodexAccountId();
    if (accountId) {
      headers["ChatGPT-Account-ID"] = accountId;
    }
  }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(reqBody),
  });

  if (!resp.ok || !resp.body) {
    const text = await safeText(resp);
    console.error(`[codex] API error ${resp.status}: ${text}`);
    throw new Error(
      `OpenAI API returned ${resp.status}: ${text.slice(0, 300)}`,
    );
  }

  // ── Stream response and convert to Anthropic SSE format ────────────

  const msgId = `msg_${Date.now()}`;
  let contentIndex = 0;
  let hasStartedMessage = false;
  let hasStartedThinking = false;
  let hasStartedContent = false;

  // For Responses API: track function calls by output_index
  const pendingFunctionCalls: Record<
    number,
    { id: string; name: string; arguments: string }
  > = {};
  // For Chat Completions: track tool calls by index
  const pendingToolCalls: Record<
    number,
    { id: string; name: string; arguments: string }
  > = {};

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
      if (!data || data === "[DONE]") return;
      try {
        const json = JSON.parse(data);

        if (isOAuth) {
          // ── Responses API streaming events ──
          handleResponsesEvent(json);
        } else {
          // ── Chat Completions streaming events ──
          handleChatCompletionsEvent(json);
        }
      } catch {
        // ignore parse errors
      }
    },
  });

  function handleResponsesEvent(json: any) {
    const type = json.type;

    // Reasoning summary text delta
    if (type === "response.reasoning_summary_text.delta") {
      const text = json.delta;
      if (text) {
        ensureThinkingBlockStarted();
        sendEvent(res, "content_block_delta", {
          type: "content_block_delta",
          index: contentIndex,
          delta: { type: "thinking_delta", thinking: text },
        });
      }
    }

    // Output text delta (main response text)
    if (type === "response.output_text.delta") {
      const text = json.delta;
      if (text) {
        ensureContentBlockStarted();
        sendEvent(res, "content_block_delta", {
          type: "content_block_delta",
          index: contentIndex,
          delta: { type: "text_delta", text },
        });
      }
    }

    // Function call arguments delta
    if (type === "response.function_call_arguments.delta") {
      const idx = json.output_index ?? 0;
      if (!pendingFunctionCalls[idx]) {
        pendingFunctionCalls[idx] = { id: "", name: "", arguments: "" };
      }
      pendingFunctionCalls[idx].arguments += json.delta || "";
    }

    // Function call arguments done - capture id and name
    if (type === "response.function_call_arguments.done") {
      const idx = json.output_index ?? 0;
      if (!pendingFunctionCalls[idx]) {
        pendingFunctionCalls[idx] = { id: "", name: "", arguments: "" };
      }
      // Full arguments available
      if (json.arguments) pendingFunctionCalls[idx].arguments = json.arguments;
    }

    // Output item added - capture function call metadata
    if (type === "response.output_item.added") {
      const item = json.item;
      if (item?.type === "function_call") {
        const idx = json.output_index ?? 0;
        pendingFunctionCalls[idx] = {
          id: item.call_id || item.id || `call_${Date.now()}`,
          name: item.name || "",
          arguments: "",
        };
      }
    }

    // Output item done - finalize function call
    if (type === "response.output_item.done") {
      const item = json.item;
      if (item?.type === "function_call") {
        const idx = json.output_index ?? 0;
        if (pendingFunctionCalls[idx]) {
          pendingFunctionCalls[idx].id =
            item.call_id || item.id || pendingFunctionCalls[idx].id;
          pendingFunctionCalls[idx].name =
            item.name || pendingFunctionCalls[idx].name;
          if (item.arguments)
            pendingFunctionCalls[idx].arguments = item.arguments;
        }
      }
    }

    // Web search call - log it
    if (
      type === "response.output_item.added" &&
      json.item?.type === "web_search_call"
    ) {
      console.log(
        `[codex] Web search: ${JSON.stringify(json.item.action || {})}`,
      );
    }
  }

  function handleChatCompletionsEvent(json: any) {
    const choice = json.choices?.[0];
    if (!choice) return;
    const delta = choice.delta;
    if (!delta) return;

    // Handle reasoning/thinking tokens
    const reasoningChunk = delta.reasoning || delta.reasoning_content || "";
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
        if (tc.function?.arguments)
          pendingToolCalls[idx].arguments += tc.function.arguments;
      }
    }
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value, { stream: true }));
  }

  // ── Finalize ────────────────────────────────────────────────────────

  ensureMessageStarted();
  closeThinkingBlock();
  closeContentBlock();

  // Emit tool_use blocks from either API format
  const allToolCalls = isOAuth
    ? Object.values(pendingFunctionCalls)
    : Object.values(pendingToolCalls);

  if (allToolCalls.length > 0) {
    for (const tc of allToolCalls) {
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
          partial_json: tc.arguments,
        },
      });

      sendEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index: contentIndex,
      });

      contentIndex++;
    }
  }

  const stopReason = allToolCalls.length > 0 ? "tool_use" : "end_turn";

  sendEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 0 },
  });
  sendEvent(res, "message_stop", { type: "message_stop" });

  res.raw.end();
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Simple Anthropic → OpenAI Chat Completions message converter (for API key mode) */
function toOpenAIMessagesFromAnthropic(messages: AnthropicMessage[]) {
  const out: any[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const textParts: string[] = [];
    const toolCalls: any[] = [];
    const toolResults: any[] = [];
    for (const block of m.content as AnthropicContentBlock[]) {
      if (block.type === "text") textParts.push(block.text);
      else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments:
              typeof block.input === "string"
                ? block.input
                : JSON.stringify(block.input),
          },
        });
      } else if (block.type === "tool_result") {
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content:
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content),
        });
      }
    }
    if (m.role === "assistant" && toolCalls.length > 0) {
      out.push({
        role: "assistant",
        content: textParts.join("") || null,
        tool_calls: toolCalls,
      });
    } else if (textParts.length > 0) {
      out.push({ role: m.role, content: textParts.join("") });
    }
    for (const tr of toolResults) out.push(tr);
  }
  return out;
}

async function safeText(resp: Response) {
  try {
    return await resp.text();
  } catch {
    return "<no-body>";
  }
}
