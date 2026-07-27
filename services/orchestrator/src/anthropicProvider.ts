import Anthropic from "@anthropic-ai/sdk";
import type { ChatTurn, ImageAttachment, LlmReply } from "./types.js";

const DEFAULT_MODEL = "claude-opus-4-8";

export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY environment variable");
    cachedClient = new Anthropic({ apiKey });
  }
  return cachedClient;
}

const FALLBACK_TEXT = "Sorry, I couldn't come up with an answer. Please try rephrasing your question.";

export async function getAnthropicReply(params: {
  systemPrompt: string;
  history: ChatTurn[];
  message: string;
  maxTokens: number;
  image?: ImageAttachment | null;
}): Promise<LlmReply> {
  const { systemPrompt, history, message, maxTokens, image } = params;
  const client = getClient();

  // A screenshot/photo is read directly by the model (vision), not OCR'd
  // separately first -- Claude reads the text in the image and reasons
  // about it in one pass. The text part is only included when the student
  // actually typed a caption; Anthropic's API doesn't want an empty text
  // block sitting next to the image.
  const userContent: Anthropic.MessageParam["content"] = image
    ? [
        { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } },
        ...(message.trim() ? [{ type: "text" as const, text: message }] : []),
      ]
    : message;

  const response = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [...history, { role: "user" as const, content: userContent }],
  });
  const textBlock = response.content.find((block) => block.type === "text");
  return {
    text: textBlock && textBlock.type === "text" ? textBlock.text : FALLBACK_TEXT,
    model: response.model,
    usage: {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
    },
  };
}
