import Anthropic from "@anthropic-ai/sdk";
import type { ChatTurn, ImageAttachment, LlmReply } from "./types.js";

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey)
      throw new Error("Missing ANTHROPIC_API_KEY environment variable");
    cachedClient = new Anthropic({ apiKey });
  }
  return cachedClient;
}

const FALLBACK_TEXT =
  "Sorry, I couldn't come up with an answer. Please try rephrasing your question.";

export async function getAnthropicReply(params: {
  systemPrompt: string;
  history: ChatTurn[];
  message: string;
  maxTokens: number;
  image?: ImageAttachment | null;
  // The tier-resolved model id -- see llm.ts's own LlmTier comment.
  model: string;
}): Promise<LlmReply> {
  const { systemPrompt, history, message, maxTokens, image, model } = params;
  const client = getClient();

  // A screenshot/photo is read directly by the model (vision), not OCR'd
  // separately first -- Claude reads the text in the image and reasons
  // about it in one pass. The text part is only included when the student
  // actually typed a caption; Anthropic's API doesn't want an empty text
  // block sitting next to the image.
  const userContent: Anthropic.MessageParam["content"] = image
    ? [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: image.mediaType,
            data: image.base64,
          },
        },
        ...(message.trim() ? [{ type: "text" as const, text: message }] : []),
      ]
    : message;

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [...history, { role: "user" as const, content: userContent }],
  });
  const textBlock = response.content.find((block) => block.type === "text");
  return {
    text:
      textBlock && textBlock.type === "text" ? textBlock.text : FALLBACK_TEXT,
    model: response.model,
    usage: {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
    },
  };
}

// Sibling of getAnthropicReply above, for the practice-paper "evaluate"
// route only -- takes N images (every page of a photographed answer sheet)
// in one message instead of at most one, and no history/message text at
// all (the grading prompt is entirely self-contained in systemPrompt, see
// buildPracticePaperGradingPrompt). No native JSON mode to reach for on
// this provider -- relies on the prompt's own strict OUTPUT instruction
// plus the lenient extraction in practicePaperGrading.ts, an intentional,
// documented asymmetry with the Azure sibling below, which does have one.
const GRADING_FALLBACK_TEXT = '{"results":[],"overallFeedback":""}';

export async function getAnthropicGradingReply(params: {
  systemPrompt: string;
  images: ImageAttachment[];
  maxTokens: number;
  model: string;
}): Promise<LlmReply> {
  const { systemPrompt, images, maxTokens, model } = params;
  const client = getClient();

  const userContent: Anthropic.MessageParam["content"] = [
    ...images.map((image) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: image.mediaType,
        data: image.base64,
      },
    })),
    {
      type: "text" as const,
      text: "Grade this submission now, following the JSON output format specified.",
    },
  ];

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user" as const, content: userContent }],
  });
  const textBlock = response.content.find((block) => block.type === "text");
  return {
    text:
      textBlock && textBlock.type === "text"
        ? textBlock.text
        : GRADING_FALLBACK_TEXT,
    model: response.model,
    usage: {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
    },
  };
}
