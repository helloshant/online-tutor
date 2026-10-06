import { GoogleGenAI, type Content, type Part } from "@google/genai";
import type {
  ChatTurn,
  ImageAttachment,
  LlmReply,
  SystemPromptInput,
} from "./types.js";

let cachedClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!cachedClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY environment variable");
    // No `vertexai`/`project`/`location` set -- this talks to the plain
    // Gemini Developer API (ai.google.dev) with just an API key, the same
    // shape as every other provider key in this app (Anthropic, Voyage).
    // Vertex AI is a different, GCP-service-account-based auth path this
    // app has no other use for.
    cachedClient = new GoogleGenAI({ apiKey });
  }
  return cachedClient;
}

const FALLBACK_TEXT =
  "Sorry, I couldn't come up with an answer. Please try rephrasing your question.";

// Gemini has no explicit cache-breakpoint syntax the way Anthropic's
// cache_control does -- Gemini 2.5 models apply IMPLICIT caching
// automatically to a request's repeated prefix, no code required, so
// concatenating stable+volatile in that order (same as the Azure OpenAI
// provider) is all this needs to still benefit from it when it applies.
// Gemini also has a separate EXPLICIT caching resource (`ai.caches`,
// create-then-reference-by-handle, its own minimum token count and TTL to
// manage) that would guarantee a cache hit the way Anthropic's
// cache_control does -- deliberately not built here, same reasoning as not
// building Azure's equivalent: out of scope for "add a Gemini provider."
function resolveSystemInstruction(systemPrompt: SystemPromptInput): string {
  return typeof systemPrompt === "string"
    ? systemPrompt
    : systemPrompt.stable + systemPrompt.volatile;
}

// Gemini's own role vocabulary is "user"/"model", not this app's
// "user"/"assistant" (which matches Anthropic's and OpenAI's naming) --
// everywhere else in this codebase that stores/passes a ChatTurn keeps the
// app's own naming, so the translation happens only here, at the one
// provider that actually needs it.
function toGeminiRole(role: ChatTurn["role"]): "user" | "model" {
  return role === "assistant" ? "model" : "user";
}

export async function getGeminiReply(params: {
  systemPrompt: SystemPromptInput;
  history: ChatTurn[];
  message: string;
  maxTokens: number;
  image?: ImageAttachment | null;
  // The tier-resolved model id -- see llm.ts's own LlmTier comment.
  model: string;
}): Promise<LlmReply> {
  const { systemPrompt, history, message, maxTokens, image, model } = params;
  const client = getClient();

  // Same vision posture as the Anthropic/Azure providers: the image is read
  // directly by the model, not OCR'd first, and the caption part is only
  // included when the student actually typed one.
  const userParts: Part[] = image
    ? [
        { inlineData: { mimeType: image.mediaType, data: image.base64 } },
        ...(message.trim() ? [{ text: message }] : []),
      ]
    : [{ text: message }];

  const contents: Content[] = [
    ...history.map(
      (turn): Content => ({
        role: toGeminiRole(turn.role),
        parts: [{ text: turn.content }],
      }),
    ),
    { role: "user", parts: userParts },
  ];

  const response = await client.models.generateContent({
    model,
    contents,
    config: {
      systemInstruction: resolveSystemInstruction(systemPrompt),
      maxOutputTokens: maxTokens,
    },
  });

  return {
    text: response.text?.trim() ? response.text : FALLBACK_TEXT,
    model,
    usage: {
      promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

// Sibling of getGeminiReply above, for the practice-paper "evaluate" route
// only -- see getAnthropicGradingReply's own comment in anthropicProvider.ts
// for why this exists as a separate function rather than widening the one
// above. Adds responseMimeType: "application/json", the same free
// reliability win the Azure sibling's response_format: json_object gets
// (Anthropic has no equivalent) -- the model still gets the exact JSON
// shape spelled out in the prompt itself.
const GRADING_FALLBACK_TEXT = '{"results":[],"overallFeedback":""}';

export async function getGeminiGradingReply(params: {
  systemPrompt: string;
  images: ImageAttachment[];
  maxTokens: number;
  model: string;
}): Promise<LlmReply> {
  const { systemPrompt, images, maxTokens, model } = params;
  const client = getClient();

  const parts: Part[] = [
    ...images.map(
      (image): Part => ({
        inlineData: { mimeType: image.mediaType, data: image.base64 },
      }),
    ),
    {
      text: "Grade this submission now, following the JSON output format specified.",
    },
  ];

  const response = await client.models.generateContent({
    model,
    contents: [{ role: "user", parts }],
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: maxTokens,
      responseMimeType: "application/json",
    },
  });

  return {
    text: response.text?.trim() ? response.text : GRADING_FALLBACK_TEXT,
    model,
    usage: {
      promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}
