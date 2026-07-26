import { getAnthropicReply } from "./anthropicProvider.js";
import { getAzureOpenAIReply } from "./azureOpenAIProvider.js";
import type { ChatTurn } from "./types.js";

export type LlmProvider = "anthropic" | "azure-openai";

// Defaults to Anthropic; set LLM_PROVIDER=azure-openai to switch.
export function getActiveLlmProvider(): LlmProvider {
  return process.env.LLM_PROVIDER === "azure-openai" ? "azure-openai" : "anthropic";
}

export async function getChatReply(params: {
  systemPrompt: string;
  history: ChatTurn[];
  message: string;
  maxTokens: number;
}): Promise<string> {
  return getActiveLlmProvider() === "azure-openai" ? getAzureOpenAIReply(params) : getAnthropicReply(params);
}
