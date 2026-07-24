import "server-only";

import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = "claude-opus-4-8";

// Overridable via env so the deployer can trade off cost vs. quality without
// a code change; defaults to Anthropic's current flagship model.
export const CHAT_MODEL = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

let cachedClient: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY environment variable");
    cachedClient = new Anthropic({ apiKey });
  }
  return cachedClient;
}
