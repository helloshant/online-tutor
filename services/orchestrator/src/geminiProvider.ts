import { GoogleGenAI, type Content, type Part } from "@google/genai";
import type {
  ChatTurn,
  ImageAttachment,
  LlmReply,
  SystemPromptInput,
} from "./types.js";
// Type-only -- erased at compile time, so this doesn't create a real
// runtime circular import with llm.ts (which imports the functions below
// from this file).
import type { LlmTier } from "./llm.js";

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

// Gemini 2.5+/3.x models spend hidden "thinking" tokens before the visible
// reply by default (automatic budget, unset by this provider until now) --
// real latency, and real cost (thinking tokens bill as output). Reported
// directly: exercise generation (standard tier) got noticeably slower after
// switching to Gemini, exactly where it matters most -- that path runs up
// to 41 calls for one practice paper, so added latency/cost compounds hard
// there. Disabled (thinkingBudget: 0) for standard and economy -- writing a
// practice question from an archetype, or the answer-bank/emphasis work
// economy does, doesn't need extended reasoning, it needs fast, direct
// output matching a spelled-out format. A bounded, non-zero budget for
// flagship: chat tutoring and grading are where multi-step reasoning (this
// app's own [STEP]-by-[STEP] math, judgment-call grading) can genuinely
// benefit from it, and that path is one on-demand call at a time, not a
// 41-call batch -- but "automatic" (undefined, Gemini's own default, used
// here until this was confirmed as the cause) is NOT safe to leave
// unbounded: Gemini counts thinking tokens against the SAME
// maxOutputTokens budget as the visible reply, so automatic thinking can
// (and, confirmed live via chat_events, routinely did -- a two-step
// compound-interest problem got a 61-token reply, cut off mid-sentence,
// after presumably consuming nearly the entire 1536-token cap on hidden
// thinking) consume almost the whole budget and leave the actual answer
// truncated with no warning. FLAGSHIP_THINKING_BUDGET below bounds that,
// and getGeminiReply/getGeminiGradingReply add it on top of the caller's
// own maxTokens when it applies, so the visible completion always gets
// the FULL maxTokens regardless of how much (bounded) thinking happens
// first.
const FLAGSHIP_THINKING_BUDGET = 2048;

function resolveThinkingConfig(tier: LlmTier): { thinkingBudget: number } | undefined {
  return tier === "flagship"
    ? { thinkingBudget: FLAGSHIP_THINKING_BUDGET }
    : { thinkingBudget: 0 };
}

// Adds FLAGSHIP_THINKING_BUDGET on top of the caller's own maxTokens only
// when thinking is actually bounded-but-nonzero (flagship) -- see
// resolveThinkingConfig's own comment. Zero extra for standard/economy
// (thinkingBudget: 0, nothing to reserve room for).
function resolveMaxOutputTokens(maxTokens: number, tier: LlmTier): number {
  return tier === "flagship" ? maxTokens + FLAGSHIP_THINKING_BUDGET : maxTokens;
}

export async function getGeminiReply(params: {
  systemPrompt: SystemPromptInput;
  history: ChatTurn[];
  message: string;
  maxTokens: number;
  image?: ImageAttachment | null;
  // The tier-resolved model id -- see llm.ts's own LlmTier comment.
  model: string;
  tier: LlmTier;
}): Promise<LlmReply> {
  const { systemPrompt, history, message, maxTokens, image, model, tier } =
    params;
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
      maxOutputTokens: resolveMaxOutputTokens(maxTokens, tier),
      thinkingConfig: resolveThinkingConfig(tier),
    },
  });

  // response.modelVersion -- what Gemini actually served -- not the `model`
  // request param, matching the Anthropic provider's own response.model
  // posture: harmless when `model` is already a specific pinned version
  // (the two agree), but necessary once a GEMINI_MODEL_* tier is set to one
  // of Google's "-latest" aliases (see llm.ts's own GEMINI_TIER_MODELS
  // comment on why this app uses those) -- recording the alias string
  // itself into chat_events would both lose which concrete model actually
  // answered and break /admin/observability's cost lookup, which is keyed
  // by concrete model id in pricing.ts, not by alias.
  return {
    text: response.text?.trim() ? response.text : FALLBACK_TEXT,
    model: response.modelVersion || model,
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
  tier: LlmTier;
}): Promise<LlmReply> {
  const { systemPrompt, images, maxTokens, model, tier } = params;
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
      maxOutputTokens: resolveMaxOutputTokens(maxTokens, tier),
      thinkingConfig: resolveThinkingConfig(tier),
      responseMimeType: "application/json",
    },
  });

  return {
    text: response.text?.trim() ? response.text : GRADING_FALLBACK_TEXT,
    model: response.modelVersion || model,
    usage: {
      promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}
