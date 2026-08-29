import { getAnthropicCompletion } from "./anthropicProvider.js";
import { getAzureOpenAICompletion } from "./azureOpenAIProvider.js";
import type { LlmReply, PdfAttachment } from "./llmTypes.js";

export type LlmProvider = "anthropic" | "azure-openai";

// Independent of the orchestrator's own LLM_PROVIDER -- mining can run on a
// different provider/model than the one answering live student chat.
export function getActiveLlmProvider(): LlmProvider {
  return process.env.LLM_PROVIDER === "azure-openai" ? "azure-openai" : "anthropic";
}

export async function getCompletion(params: {
  systemPrompt: string;
  message: string;
  maxTokens: number;
  pdf?: PdfAttachment | null;
}): Promise<LlmReply> {
  return getActiveLlmProvider() === "azure-openai"
    ? getAzureOpenAICompletion(params)
    : getAnthropicCompletion(params);
}
