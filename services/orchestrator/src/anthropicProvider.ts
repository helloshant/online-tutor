import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatTurn,
  ImageAttachment,
  LlmReply,
  SystemPromptInput,
} from "./types.js";

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey)
      throw new Error("Missing ANTHROPIC_API_KEY environment variable");
    cachedClient = new Anthropic({ apiKey });
  }
  return cachedClient;
}

const FALLBACK_TEXT =
  "Sorry, I couldn't come up with an answer. Please try rephrasing your question.";

// Builds the `system` field for a prompt-caching-aware call. A plain string
// (every prompt builder except buildTutorSystemPrompt) becomes one ordinary,
// uncached block -- unchanged behavior from before caching existed, since a
// short, rarely-repeated prompt isn't worth paying the cache-write premium
// on. The {stable, volatile} shape (see SystemPromptInput's own comment in
// types.ts) becomes a cached block for `stable`, optionally followed by one
// more uncached block for `volatile` when it's non-empty -- Anthropic's API
// rejects an empty text block, and the common case (no image, no RAG match,
// no standout relevant topic) genuinely has nothing to put there.
function buildSystemBlocks(
  systemPrompt: SystemPromptInput,
): Anthropic.MessageCreateParams["system"] {
  if (typeof systemPrompt === "string") return systemPrompt;
  const { stable, volatile } = systemPrompt;
  const blocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: stable, cache_control: { type: "ephemeral" } },
  ];
  if (volatile) blocks.push({ type: "text", text: volatile });
  return blocks;
}

// Marks the END of `history` (everything the student and the model have
// already said in this conversation so far) as a cache breakpoint, so the
// NEXT turn -- which resends this exact same history, plus one more
// exchange appended -- can reuse it instead of reprocessing the whole
// conversation from scratch. Only the single last turn needs the
// breakpoint: Anthropic caches everything from the start of the request up
// to and including a marked block, so one breakpoint at the end covers the
// entire prefix. A fresh conversation (empty history) has nothing to cache
// yet -- this is a no-op until the second turn.
function buildMessages(
  history: ChatTurn[],
  userContent: Anthropic.MessageParam["content"],
): Anthropic.MessageParam[] {
  if (history.length === 0) {
    return [{ role: "user", content: userContent }];
  }
  const cachedHistory: Anthropic.MessageParam[] = history.map(
    (turn, i): Anthropic.MessageParam =>
      i === history.length - 1
        ? {
            role: turn.role,
            content: [
              {
                type: "text",
                text: turn.content,
                cache_control: { type: "ephemeral" },
              },
            ],
          }
        : { role: turn.role, content: turn.content },
  );
  return [...cachedHistory, { role: "user", content: userContent }];
}

// Anthropic reports cache-written and cache-read tokens SEPARATELY from
// input_tokens, each at its own price (a 5-minute-TTL cache write costs
// 1.25x an ordinary input token -- the price of writing it once, so a later
// call can read it cheap; a cache read costs 0.1x). The observability
// service's own cost model (services/observability/src/pricing.ts) has no
// notion of this -- one flat inputPerMTok rate -- and extending it would
// mean a schema change (new chat_events columns) across two services just
// to track a rate Anthropic itself already discounts automatically. Instead,
// this folds the cache tokens into a single cost-EQUIVALENT prompt-token
// count at the flat rate, using Anthropic's own published multipliers, so
// /admin/observability's existing cost figures stay accurate once caching
// is live instead of silently under-counting real spend (cache_creation/
// cache_read tokens are real, billed tokens that input_tokens alone no
// longer reflects once caching is in use).
const CACHE_WRITE_COST_MULTIPLIER = 1.25; // 5-minute TTL (this app's default)
const CACHE_READ_COST_MULTIPLIER = 0.1;

function effectivePromptTokens(usage: Anthropic.Usage): number {
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return Math.round(
    usage.input_tokens +
      cacheWrite * CACHE_WRITE_COST_MULTIPLIER +
      cacheRead * CACHE_READ_COST_MULTIPLIER,
  );
}

export async function getAnthropicReply(params: {
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

  // A screenshot/photo is read directly by the model (vision), not OCR'd
  // separately first -- Claude reads the text in the image and reasons
  // about it in one pass. The text part is only included when the student
  // actually typed a caption; Anthropic's API doesn't want an empty text
  // block sitting next to the image.
  const userContent: Anthropic.MessageParam["content"] = image
    ? [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: image.mediaType,
            data: image.base64,
          },
        },
        ...(message.trim() ? [{ type: "text" as const, text: message }] : []),
      ]
    : message;

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: buildSystemBlocks(systemPrompt),
    messages: buildMessages(history, userContent),
  });
  const textBlock = response.content.find((block) => block.type === "text");
  return {
    text:
      textBlock && textBlock.type === "text" ? textBlock.text : FALLBACK_TEXT,
    model: response.model,
    usage: {
      promptTokens: effectivePromptTokens(response.usage),
      completionTokens: response.usage.output_tokens,
    },
  };
}

// Sibling of getAnthropicReply above, for the practice-paper "evaluate"
// route only -- takes N images (every page of a photographed answer sheet)
// in one message instead of at most one, and no history/message text at
// all (the grading prompt is entirely self-contained in systemPrompt, see
// buildPracticePaperGradingPrompt). No native JSON mode to reach for on
// this provider -- relies on the prompt's own strict OUTPUT instruction
// plus the lenient extraction in practicePaperGrading.ts, an intentional,
// documented asymmetry with the Azure sibling below, which does have one.
const GRADING_FALLBACK_TEXT = '{"results":[],"overallFeedback":""}';

export async function getAnthropicGradingReply(params: {
  systemPrompt: string;
  images: ImageAttachment[];
  maxTokens: number;
  model: string;
}): Promise<LlmReply> {
  const { systemPrompt, images, maxTokens, model } = params;
  const client = getClient();

  const userContent: Anthropic.MessageParam["content"] = [
    ...images.map((image) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: image.mediaType,
        data: image.base64,
      },
    })),
    {
      type: "text" as const,
      text: "Grade this submission now, following the JSON output format specified.",
    },
  ];

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user" as const, content: userContent }],
  });
  const textBlock = response.content.find((block) => block.type === "text");
  return {
    text:
      textBlock && textBlock.type === "text"
        ? textBlock.text
        : GRADING_FALLBACK_TEXT,
    model: response.model,
    usage: {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
    },
  };
}
