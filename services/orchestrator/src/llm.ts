import {
  getAnthropicReply,
  getAnthropicGradingReply,
} from "./anthropicProvider.js";
import {
  getAzureOpenAIReply,
  getAzureOpenAIGradingReply,
} from "./azureOpenAIProvider.js";
import type { ChatTurn, ImageAttachment, LlmReply } from "./types.js";

export type LlmProvider = "anthropic" | "azure-openai";

// Defaults to Anthropic; set LLM_PROVIDER=azure-openai to switch.
export function getActiveLlmProvider(): LlmProvider {
  return process.env.LLM_PROVIDER === "azure-openai"
    ? "azure-openai"
    : "anthropic";
}

export async function getChatReply(params: {
  systemPrompt: string;
  history: ChatTurn[];
  message: string;
  maxTokens: number;
  image?: ImageAttachment | null;
}): Promise<LlmReply> {
  return getActiveLlmProvider() === "azure-openai"
    ? getAzureOpenAIReply(params)
    : getAnthropicReply(params);
}

// A brand-new, parallel path for the practice-paper "evaluate" route only --
// takes one or more images (a photographed answer sheet can span several
// pages) and no chat history, unlike getChatReply above. Deliberately kept
// separate rather than widening getChatReply's own `image` param to an
// array: getChatReply backs the chat/exercise-generation/exercise-grading
// paths, all of which only ever take at most one image, and none of them
// need to change to support this.
export async function getGradingReply(params: {
  systemPrompt: string;
  images: ImageAttachment[];
  maxTokens: number;
}): Promise<LlmReply> {
  return getActiveLlmProvider() === "azure-openai"
    ? getAzureOpenAIGradingReply(params)
    : getAnthropicGradingReply(params);
}
