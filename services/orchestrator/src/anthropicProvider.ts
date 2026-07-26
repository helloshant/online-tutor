import Anthropic from "@anthropic-ai/sdk";
import type { ChatTurn } from "./types.js";

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
}): Promise<string> {
  const { systemPrompt, history, message, maxTokens } = params;
  const client = getClient();
  const response = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [...history, { role: "user" as const, content: message }],
  });
  const textBlock = response.content.find((block) => block.type === "text");
  return textBlock && textBlock.type === "text" ? textBlock.text : FALLBACK_TEXT;
}
