import { AzureOpenAI } from "openai";
import type { ChatTurn, ImageAttachment, LlmReply } from "./types.js";

const DEFAULT_API_VERSION = "2024-08-01-preview";

// Azure OpenAI bills/routes per DEPLOYMENT -- the SDK bakes the deployment
// into the client at construction time (it builds request URLs like
// /openai/deployments/{deployment}/chat/completions), not per individual
// request the way a plain "model" field would work for Anthropic or the
// OpenAI public API. Tiering (see llm.ts's own LlmTier) means a single
// request can now ask for any of up to three different deployments, so this
// caches one client PER deployment actually used, rather than the single
// module-level client this used to be -- each tier still only ever pays for
// one client's worth of setup, the first time that specific deployment is
// requested.
const cachedClients = new Map<string, AzureOpenAI>();

function getClient(deployment: string): AzureOpenAI {
  let client = cachedClients.get(deployment);
  if (!client) {
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    if (!apiKey)
      throw new Error("Missing AZURE_OPENAI_API_KEY environment variable");
    if (!endpoint)
      throw new Error("Missing AZURE_OPENAI_ENDPOINT environment variable");

    client = new AzureOpenAI({
      apiKey,
      endpoint,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION || DEFAULT_API_VERSION,
      deployment,
    });
    cachedClients.set(deployment, client);
  }
  return client;
}

const FALLBACK_TEXT =
  "Sorry, I couldn't come up with an answer. Please try rephrasing your question.";

export async function getAzureOpenAIReply(params: {
  systemPrompt: string;
  history: ChatTurn[];
  message: string;
  maxTokens: number;
  image?: ImageAttachment | null;
  // The tier-resolved deployment name -- see llm.ts's own LlmTier comment.
  model: string;
}): Promise<LlmReply> {
  const { systemPrompt, history, message, maxTokens, image, model } = params;
  const client = getClient(model);

  // OpenAI's vision format: an image_url part with a data: URI, alongside
  // the caption if one was typed -- same reasoning as the Anthropic
  // provider's text-part omission when there's no caption.
  const userContent = image
    ? [
        {
          type: "image_url" as const,
          image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
        },
        ...(message.trim() ? [{ type: "text" as const, text: message }] : []),
      ]
    : message;

  const completion = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      ...history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: "user" as const, content: userContent },
    ],
  });
  return {
    text: completion.choices[0]?.message?.content ?? FALLBACK_TEXT,
    // The deployment name, not the underlying base model -- Azure bills and
    // rate-limits against the deployment, so that's the identifier the
    // observability service's pricing lookup needs.
    model,
    usage: {
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
    },
  };
}

// Sibling of getAzureOpenAIReply above, for the practice-paper "evaluate"
// route only -- see getAnthropicGradingReply's own comment for why this
// exists as a separate function rather than widening the one above. Adds
// response_format: json_object, a free reliability win specific to this
// provider (Anthropic has no equivalent to reach for) -- the model still
// gets the exact JSON shape spelled out in the prompt itself.
const GRADING_FALLBACK_TEXT = '{"results":[],"overallFeedback":""}';

export async function getAzureOpenAIGradingReply(params: {
  systemPrompt: string;
  images: ImageAttachment[];
  maxTokens: number;
  model: string;
}): Promise<LlmReply> {
  const { systemPrompt, images, maxTokens, model } = params;
  const client = getClient(model);

  const userContent = [
    ...images.map((image) => ({
      type: "image_url" as const,
      image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
    })),
    {
      type: "text" as const,
      text: "Grade this submission now, following the JSON output format specified.",
    },
  ];

  const completion = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user" as const, content: userContent },
    ],
  });
  return {
    text: completion.choices[0]?.message?.content ?? GRADING_FALLBACK_TEXT,
    model,
    usage: {
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
    },
  };
}
