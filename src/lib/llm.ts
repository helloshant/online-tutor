import "server-only";

import { CHAT_MODEL, getAnthropicClient } from "./anthropic";
import { AZURE_OPENAI_DEPLOYMENT, getAzureOpenAIClient } from "./azureOpenai";

export type LlmProvider = "anthropic" | "azure-openai";
export type ChatTurn = { role: "user" | "assistant"; content: string };

const FALLBACK_TEXT = "Sorry, I couldn't come up with an answer. Please try rephrasing your question.";

// Defaults to Anthropic; set LLM_PROVIDER=azure-openai to switch. Nothing
// else in the app needs to know which provider is active -- callers just
// get a plain string reply back.
export function getActiveLlmProvider(): LlmProvider {
  return process.env.LLM_PROVIDER === "azure-openai" ? "azure-openai" : "anthropic";
}

export async function getChatReply(params: {
  systemPrompt: string;
  history: ChatTurn[];
  message: string;
  maxTokens: number;
}): Promise<string> {
  return getActiveLlmProvider() === "azure-openai"
    ? getAzureOpenAIReply(params)
    : getAnthropicReply(params);
}

async function getAnthropicReply({
  systemPrompt,
  history,
  message,
  maxTokens,
}: {
  systemPrompt: string;
  history: ChatTurn[];
  message: string;
  maxTokens: number;
}): Promise<string> {
  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: CHAT_MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [...history, { role: "user" as const, content: message }],
  });
  const textBlock = response.content.find((block) => block.type === "text");
  return textBlock && textBlock.type === "text" ? textBlock.text : FALLBACK_TEXT;
}

async function getAzureOpenAIReply({
  systemPrompt,
  history,
  message,
  maxTokens,
}: {
  systemPrompt: string;
  history: ChatTurn[];
  message: string;
  maxTokens: number;
}): Promise<string> {
  const client = getAzureOpenAIClient();
  const completion = await client.chat.completions.create({
    model: AZURE_OPENAI_DEPLOYMENT,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      ...history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: "user" as const, content: message },
    ],
  });
  return completion.choices[0]?.message?.content ?? FALLBACK_TEXT;
}
