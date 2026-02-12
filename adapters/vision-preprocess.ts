// Vision preprocessing: converts image blocks to text descriptions for non-vision models
import { createHash } from "crypto";
import type { AnthropicRequest } from "./types.js";

const DEFAULT_VISION_MODEL = "google/gemini-2.5-flash";
const DESCRIBE_PROMPT =
  "Describe this image in granular detail — layout, text, colors, objects, spatial relationships, any code or data visible.";

// In-memory cache: hash of image data → description text
const descriptionCache = new Map<string, string>();

function imageKey(block: ImageBlock): string {
  if (block.source.type === "url" && block.source.url) {
    return "url:" + block.source.url;
  }
  // Hash first 2048 chars of base64 + length for a fast, collision-resistant key
  const data = block.source.data;
  return createHash("sha256").update(data.slice(0, 2048) + ":" + data.length).digest("hex");
}

interface ImageBlock {
  type: "image";
  source: { type: string; media_type: string; data: string; url?: string };
}

function isImageBlock(block: any): block is ImageBlock {
  return block?.type === "image";
}

async function describeImage(
  block: ImageBlock,
  model: string,
  apiKey: string
): Promise<string> {
  const content: any[] = [
    { type: "text", text: DESCRIBE_PROMPT },
  ];

  if (block.source.type === "url" && block.source.url) {
    content.push({
      type: "image_url",
      image_url: { url: block.source.url },
    });
  } else {
    // base64
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${block.source.media_type};base64,${block.source.data}`,
      },
    });
  }

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      max_tokens: 1024,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[ccx] Vision model error (${resp.status}): ${text}`);
    return "[Image description unavailable]";
  }

  const json = (await resp.json()) as any;
  return json.choices?.[0]?.message?.content?.trim() ?? "[Image description unavailable]";
}

/**
 * Scans messages for image blocks and replaces them with text descriptions.
 * Mutates body.messages in-place.
 */
export async function preprocessImages(
  body: AnthropicRequest,
  apiKey?: string
): Promise<void> {
  if (!apiKey) {
    console.warn("[ccx] OPENROUTER_API_KEY not set — skipping image preprocessing");
    return;
  }

  const model = process.env.VISION_MODEL || DEFAULT_VISION_MODEL;

  // Collect all image blocks with their location
  const tasks: { msg: any; idx: number; block: ImageBlock }[] = [];
  for (const msg of body.messages) {
    if (!Array.isArray(msg.content)) continue;
    for (let i = 0; i < msg.content.length; i++) {
      if (isImageBlock(msg.content[i])) {
        tasks.push({ msg, idx: i, block: msg.content[i] as ImageBlock });
      }
    }
  }

  if (tasks.length === 0) return;

  // Split into cached hits and new images that need describing
  const uncached = tasks.filter((t) => !descriptionCache.has(imageKey(t.block)));
  const cached = tasks.length - uncached.length;

  if (uncached.length > 0) {
    console.log(`[ccx] Describing ${uncached.length} new image(s) via ${model} (${cached} cached)...`);
    const descriptions = await Promise.all(
      uncached.map((t) => describeImage(t.block, model, apiKey))
    );
    for (let i = 0; i < uncached.length; i++) {
      descriptionCache.set(imageKey(uncached[i].block), descriptions[i]);
    }
  } else {
    console.log(`[ccx] All ${tasks.length} image(s) served from cache`);
  }

  // Replace image blocks with text descriptions (reverse order to preserve indices)
  for (let i = tasks.length - 1; i >= 0; i--) {
    const { msg, idx } = tasks[i];
    const desc = descriptionCache.get(imageKey(tasks[i].block))!;
    msg.content[idx] = {
      type: "text",
      text: `[Image Description: ${desc}]`,
    };
  }
}
