import Anthropic from "@anthropic-ai/sdk";
import type { LlmReply, PdfAttachment } from "./llmTypes.js";

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

// Every stage prompt in this service ends with "Return ONLY valid JSON...
// No markdown, no explanatory prose" -- there's no text fallback that
// would ever make sense here the way FALLBACK_TEXT does for a student-
// facing chat reply, so an empty/missing text block is a real failure
// (jsonExtract.ts's caller decides how to handle that), not something to
// paper over with a placeholder string.
export async function getAnthropicCompletion(params: {
  systemPrompt: string;
  message: string;
  maxTokens: number;
  pdf?: PdfAttachment | null;
}): Promise<LlmReply> {
  const { systemPrompt, message, maxTokens, pdf } = params;
  const client = getClient();

  // Same shape as the orchestrator's own image attachment (see its
  // anthropicProvider.ts): the document block first, then the JSON
  // envelope (education_context/paper metadata, no raw_text field) as a
  // trailing text block -- Claude reads the PDF's pages directly rather
  // than working from a pre-extracted text layer, so this also covers
  // scanned/OCR-quality papers a text-extraction library would mangle.
  const userContent: Anthropic.MessageParam["content"] = pdf
    ? [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.base64 } },
        { type: "text", text: message },
      ]
    : message;

  const response = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
  });
  const textBlock = response.content.find((block) => block.type === "text");
  return {
    text: textBlock && textBlock.type === "text" ? textBlock.text : "",
    model: response.model,
    usage: {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
    },
  };
}
