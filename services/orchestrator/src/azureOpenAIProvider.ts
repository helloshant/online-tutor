import { AzureOpenAI } from "openai";
import type { ChatTurn } from "./types.js";

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

const FALLBACK_TEXT = "Sorry, I couldn't come up with an answer. Please try rephrasing your question.";

export async function getAzureOpenAIReply(params: {
  systemPrompt: string;
  history: ChatTurn[];
  message: string;
  maxTokens: number;
}): Promise<string> {
  const { systemPrompt, history, message, maxTokens } = params;
  const client = getClient();
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
