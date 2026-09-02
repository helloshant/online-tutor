import { AzureOpenAI } from "openai";
import type { LlmReply, PdfAttachment } from "./llmTypes.js";

const DEFAULT_DEPLOYMENT = "gpt-4o";
const DEFAULT_API_VERSION = "2024-08-01-preview";

export const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || DEFAULT_DEPLOYMENT;

let cachedClient: AzureOpenAI | null = null;

function getClient(): AzureOpenAI {
  if (!cachedClient) {
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    if (!apiKey) throw new Error("Missing AZURE_OPENAI_API_KEY environment variable");
    if (!endpoint) throw new Error("Missing AZURE_OPENAI_ENDPOINT environment variable");

    cachedClient = new AzureOpenAI({
      apiKey,
      endpoint,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION || DEFAULT_API_VERSION,
      deployment: AZURE_OPENAI_DEPLOYMENT,
    });
  }
  return cachedClient;
}

export async function getAzureOpenAICompletion(params: {
  systemPrompt: string;
  message: string;
  maxTokens: number;
  pdf?: PdfAttachment | null;
}): Promise<LlmReply> {
  const { systemPrompt, message, maxTokens, pdf } = params;
  const client = getClient();

  // Chat Completions doesn't take a raw PDF content part the way Anthropic's
  // Messages API does (see anthropicProvider.ts) -- failing loudly here
  // beats silently ignoring the PDF and segmenting an empty/near-empty
  // message, which would look like a Stage 0 bug rather than an
  // unsupported-input error.
  if (pdf) {
    throw new Error(
      "PDF paper input isn't supported when LLM_PROVIDER=azure-openai -- extract the text and submit it as raw_text instead."
    );
  }

  const completion = await client.chat.completions.create({
    model: AZURE_OPENAI_DEPLOYMENT,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message },
    ],
  });
  return {
    text: completion.choices[0]?.message?.content ?? "",
    // The deployment name, not the underlying base model -- matches the
    // orchestrator's own reasoning for why this, not the base model name,
    // is the right identifier if this service ever reports cost anywhere.
    model: AZURE_OPENAI_DEPLOYMENT,
    usage: {
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
    },
    // "length" here means the response was truncated by maxTokens -- see
    // LlmReply.finishReason's own comment for why this matters even when
    // the truncated text still happens to parse as valid JSON.
    finishReason: completion.choices[0]?.finish_reason,
  };
}
