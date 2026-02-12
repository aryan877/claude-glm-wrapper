// Vision preprocessing: converts image blocks to text descriptions for non-vision models
import type { AnthropicRequest } from "./types.js";

const DEFAULT_VISION_MODEL = "google/gemini-2.5-flash";
const DESCRIBE_PROMPT =
  "Describe this image in granular detail — layout, text, colors, objects, spatial relationships, any code or data visible.";

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

  console.log(`[ccx] Describing ${tasks.length} image(s) via ${model}...`);

  const descriptions = await Promise.all(
    tasks.map((t) => describeImage(t.block, model, apiKey))
  );

  // Replace image blocks with text descriptions (reverse order to preserve indices)
  for (let i = tasks.length - 1; i >= 0; i--) {
    const { msg, idx } = tasks[i];
    msg.content[idx] = {
      type: "text",
      text: `[Image Description: ${descriptions[i]}]`,
    };
  }
}
