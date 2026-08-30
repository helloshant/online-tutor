import { getAnthropicCompletion } from "./anthropicProvider.js";
import { getAzureOpenAICompletion } from "./azureOpenAIProvider.js";
import type { LlmReply, PdfAttachment } from "./llmTypes.js";

export type LlmProvider = "anthropic" | "azure-openai";

// Independent of the orchestrator's own LLM_PROVIDER -- mining can run on a
// different provider/model than the one answering live student chat.
//
// Trimmed and lowercased before comparing: an exact `=== "azure-openai"`
// check silently falls back to Anthropic for ANYTHING else, including a
// value that's actually meant to select Azure but has a trailing `\r`
// (Windows-edited .env.local + Docker Compose's env_file loader keeping
// CRLF line endings verbatim is a common way to get exactly that) or
// different casing -- which manifests as an Anthropic 401 with no
// indication the provider selection itself was the problem, since nothing
// upstream of getAnthropicCompletion knows LLM_PROVIDER was ever meant to
// say something else. See server.ts's own startup log for the resolved
// value, so this is visible without needing to hit that failure first.
export function getActiveLlmProvider(): LlmProvider {
  return (process.env.LLM_PROVIDER ?? "").trim().toLowerCase() === "azure-openai" ? "azure-openai" : "anthropic";
}

export async function getCompletion(params: {
  systemPrompt: string;
  message: string;
  maxTokens: number;
  pdf?: PdfAttachment | null;
  // Per-call override -- lets one pipeline run (or one family-mining call)
  // choose a provider explicitly regardless of the service-wide
  // LLM_PROVIDER default, so an admin with both Anthropic and Azure OpenAI
  // credentials configured can pick whichever fits a given submission
  // (e.g. Anthropic for a PDF-based paper, Azure OpenAI otherwise).
  // Falls back to getActiveLlmProvider() when omitted.
  provider?: LlmProvider;
}): Promise<LlmReply> {
  const provider = params.provider ?? getActiveLlmProvider();
  return provider === "azure-openai" ? getAzureOpenAICompletion(params) : getAnthropicCompletion(params);
}
