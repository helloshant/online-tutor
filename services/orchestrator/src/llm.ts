import {
  getAnthropicReply,
  getAnthropicGradingReply,
} from "./anthropicProvider.js";
import {
  getAzureOpenAIReply,
  getAzureOpenAIGradingReply,
} from "./azureOpenAIProvider.js";
import { getGeminiReply, getGeminiGradingReply } from "./geminiProvider.js";
import { recordChatEvent } from "./observabilityClient.js";
import type {
  ChatTurn,
  ImageAttachment,
  LlmReply,
  Medium,
  SystemPromptInput,
} from "./types.js";

export type LlmProvider = "anthropic" | "azure-openai" | "gemini";

// Defaults to Anthropic; set LLM_PROVIDER=azure-openai or LLM_PROVIDER=gemini
// to switch.
export function getActiveLlmProvider(): LlmProvider {
  if (process.env.LLM_PROVIDER === "azure-openai") return "azure-openai";
  if (process.env.LLM_PROVIDER === "gemini") return "gemini";
  return "anthropic";
}

// Which model/deployment a call actually gets, chosen by matching its
// stakes/volume to a tier rather than one global model serving everything
// from a topic summary to grading a photographed answer sheet. Every
// getChatReply/getGradingReply call picks one -- see each call site's own
// comment for why it picked what it picked, but in short:
//
//   flagship -- chat tutoring, exercise-attempt grading, practice-paper
//     vision grading: directly affects a student's understanding or their
//     actual score, never the place to cut cost.
//   standard -- exercise/practice-paper question generation, topic
//     summaries: quality still matters (a bad worked-solution key misleads
//     a student self-checking) but this is also the highest-VOLUME tier
//     (up to 41 calls for one practice paper alone), so it's where
//     per-token savings compound the most.
//   economy -- the answer-bank restatement rewrite and the admin
//     chapter-notes emphasis pass: neither is ever shown directly to the
//     student whose action triggered it. Emphasis additionally verifies
//     its own output against the original and falls back to it on any
//     mismatch, independent of model quality; the restatement's worst
//     realistic failure from a weaker model is a slightly worse future
//     fuzzy-match rate for OTHER students' similar questions, not a wrong
//     answer shown to anyone. Lowest-risk place to spend less.
export type LlmTier = "flagship" | "standard" | "economy";

// Anthropic model ids are stable, ready-to-use strings -- tiering works
// immediately here with no extra setup, and all three defaults are already
// in pricing.ts's own built-in rate table, so cost tracking needs no
// LLM_PRICING_JSON change either. flagship and standard both default to
// Sonnet 5 ($3/$15 per MTok) rather than Opus -- a deliberate choice over
// Opus's $5/$25: this app's own flagship-tier work (chat tutoring, exercise
// grading) doesn't need Opus-level capability to do well, so there's no
// reason to pay its ~40% premium on both tiers with the highest combined
// volume. economy stays Haiku 4.5 ($1/$5), unrelated to this change.
const ANTHROPIC_TIER_MODELS: Record<LlmTier, string> = {
  flagship: process.env.ANTHROPIC_MODEL_FLAGSHIP || "claude-sonnet-5",
  standard: process.env.ANTHROPIC_MODEL_STANDARD || "claude-sonnet-5",
  economy: process.env.ANTHROPIC_MODEL_ECONOMY || "claude-haiku-4-5",
};

// Azure OpenAI bills/routes per DEPLOYMENT -- a name YOU chose when
// creating it in the Azure Portal, not a portable model id -- so there's no
// universal "standard gpt-4o deployment name" the way Anthropic's model ids
// allow. All three tiers default to this app's one existing deployment
// (gpt-4o) -- tiering is a true no-op on Azure, every tier resolving to the
// same place, until you provision real additional deployments and point
// the flagship/economy env vars at them. Standard's default matches this
// app's actual production deployment exactly, so nothing changes for the
// currently-live configuration unless you opt in.
const DEFAULT_AZURE_DEPLOYMENT = "gpt-4o";
const AZURE_TIER_DEPLOYMENTS: Record<LlmTier, string> = {
  flagship:
    process.env.AZURE_OPENAI_DEPLOYMENT_FLAGSHIP || DEFAULT_AZURE_DEPLOYMENT,
  standard:
    process.env.AZURE_OPENAI_DEPLOYMENT_STANDARD || DEFAULT_AZURE_DEPLOYMENT,
  economy:
    process.env.AZURE_OPENAI_DEPLOYMENT_ECONOMY || DEFAULT_AZURE_DEPLOYMENT,
};

// Gemini model ids are stable, portable strings too (same as Anthropic's),
// so each tier gets its own real model rather than Azure's single-deployment
// no-op -- mapped the same way the flagship/standard default change above
// reasoned about Anthropic: the highest-capability tier only where stakes
// genuinely call for it, the mid tier on the highest-volume work, the
// cheapest on what's never shown directly to a student.
//
// These default to Google's own "-latest" ALIASES (gemini-pro-latest/
// gemini-flash-latest/gemini-flash-lite-latest), not a specific pinned
// version -- a deliberate choice forced by what actually happened here:
// standard's pinned gemini-2.5-flash broke in production with a real 404
// ("no longer available... use gemini-3.8-flash"), confirmed straight from
// Google's own API, and a models.list check (see below) then showed
// gemini-2.5-flash ITSELF still listed as available despite 404ing on
// every real call -- proof that "present in models.list" does NOT mean
// "actually callable," so flagship/economy's then-current pinned names
// (gemini-2.5-pro, gemini-2.5-flash-lite -- also both still listed) could
// not be trusted either, and Google was cycling flash versions fast enough
// (3.1/3.5/3.6/3.7/3.8 all listed at once) that pinning the next specific
// version looked likely to break again soon. The "-latest" aliases exist
// specifically so this class of breakage stops recurring -- Google routes
// them to whatever it currently recommends, so no .env.local edit or
// redeploy is needed when the underlying model changes again. Tradeoff,
// stated plainly: Google can change what an alias points to without
// warning, which could shift output format/behavior under this app's own
// carefully-tuned prompts (the [DIAGRAM]/[STEP] instructions) -- accepted
// here given pinned names have now broken twice in a row. Cost tracking
// still works through this: getGeminiReply/getGeminiGradingReply record
// response.modelVersion (what Gemini actually resolved to), not the alias
// string, so services/observability/src/pricing.ts's lookup still has a
// real model id to match against -- see geminiProvider.ts's own comment.
// To verify what's currently valid for a real key (confirm an alias still
// resolves, or re-pin a specific version instead):
//   curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY" \
//     | grep -o '"name": "models/[^"]*"' | sort -u
const GEMINI_TIER_MODELS: Record<LlmTier, string> = {
  flagship: process.env.GEMINI_MODEL_FLAGSHIP || "gemini-pro-latest",
  standard: process.env.GEMINI_MODEL_STANDARD || "gemini-flash-latest",
  economy: process.env.GEMINI_MODEL_ECONOMY || "gemini-flash-lite-latest",
};

function resolveModel(provider: LlmProvider, tier: LlmTier): string {
  if (provider === "azure-openai") return AZURE_TIER_DEPLOYMENTS[tier];
  if (provider === "gemini") return GEMINI_TIER_MODELS[tier];
  return ANTHROPIC_TIER_MODELS[tier];
}

// Every getChatReply/getGradingReply call must supply one of these two
// variants -- see each one's own comment. This exists because three
// separate LLM-spending paths (practice-paper generation, practice-paper
// grading, and topic-exercise-attempt grading) were each found, live, to be
// spending real tokens with nothing ever recorded into chat_events --
// invisible both to the monthly usage-limit check for FUTURE requests
// (student_usage_limits) and to /admin/observability's own cost reporting.
// That happened because logging lived at each ROUTE as its own separate
// `recordChatEvent` call, easy for a new call site to just forget -- and
// three of them did. Requiring it here instead, on the two functions that
// actually make an LLM call, turns "forgot to log this" into a compile
// error instead of a silent gap.
export type LlmCallContext =
  | {
      // A genuine per-user LLM call this app can attribute to a student's
      // (or staff previewer's) own usage -- everything ChatEventInput needs
      // for a real audit-trail row, minus what this wrapper already knows
      // on its own: `source` is always "llm" here (the cache/database/
      // rejected sources in /v1/chat never reach getChatReply at all, so
      // they keep recording their own events directly, unaffected by this),
      // and provider/model/tokens/latency all come straight off the reply
      // this exact call produced.
      loggable: true;
      userId: string;
      mode: "student" | "staff";
      subjectId: string;
      boardId?: string | null;
      gradeId?: string | null;
      medium?: Medium | null;
      question: string;
      // /v1/chat's own RAG-grounding flag -- meaningless for every other
      // caller, which simply omits it.
      grounded?: boolean | null;
    }
  | {
      // The deliberate opt-out -- for a call with no student/user to
      // attribute it to at all, like /v1/chapter-documents/add-emphasis (an
      // admin content-authoring pass over arbitrary text, never tied to any
      // one student's usage). Explicit and grep-able rather than an omitted
      // field, so a future reviewer can tell "deliberately unmetered" apart
      // from "someone forgot" at a glance.
      loggable: false;
    };

function reportLlmCall(
  context: LlmCallContext,
  provider: LlmProvider,
  reply: LlmReply,
  startedAt: number,
): void {
  if (!context.loggable) return;
  // Fire-and-forget, same posture as every recordChatEvent call this
  // replaces -- observability is an add-on to the pipeline, not a
  // dependency of it, so this never adds latency to the reply the caller is
  // about to return. `provider` is this CALL's own resolved provider (the
  // caller's choice, or getActiveLlmProvider() for a caller that passed
  // none -- see getChatReply/getGradingReply) -- not re-derived from the
  // global env default, which would have recorded the wrong provider for
  // any student whose own llm_provider preference differs from it (see
  // student_wallets -- this is also what services/observability/src/
  // server.ts needs to convert this call's real cost into the RIGHT
  // wallet-token rate).
  void recordChatEvent({
    userId: context.userId,
    mode: context.mode,
    boardId: context.boardId,
    gradeId: context.gradeId,
    subjectId: context.subjectId,
    medium: context.medium,
    question: context.question,
    source: "llm",
    provider,
    model: reply.model,
    promptTokens: reply.usage.promptTokens,
    completionTokens: reply.usage.completionTokens,
    latencyMs: Date.now() - startedAt,
    grounded: context.grounded,
  });
}

export async function getChatReply(params: {
  systemPrompt: SystemPromptInput;
  history: ChatTurn[];
  message: string;
  maxTokens: number;
  image?: ImageAttachment | null;
  event: LlmCallContext;
  tier: LlmTier;
  // The caller's own resolved provider choice (a student's own
  // student_wallets.llm_provider for mode:"student", see server.ts's /v1/
  // chat and every other student-facing endpoint) -- falls back to the
  // global env default (getActiveLlmProvider()) when omitted, which is
  // what every caller with no per-user provider concept (staff mode) still
  // relies on.
  provider?: LlmProvider;
}): Promise<LlmReply> {
  const { event, tier, provider: requestedProvider, ...providerParams } =
    params;
  const provider = requestedProvider ?? getActiveLlmProvider();
  const model = resolveModel(provider, tier);
  const startedAt = Date.now();
  const reply =
    provider === "azure-openai"
      ? await getAzureOpenAIReply({ ...providerParams, model })
      : provider === "gemini"
        ? await getGeminiReply({ ...providerParams, model, tier })
        : await getAnthropicReply({ ...providerParams, model });
  reportLlmCall(event, provider, reply, startedAt);
  return reply;
}

// A brand-new, parallel path for the practice-paper "evaluate" route only --
// takes one or more images (a photographed answer sheet can span several
// pages) and no chat history, unlike getChatReply above. Deliberately kept
// separate rather than widening getChatReply's own `image` param to an
// array: getChatReply backs the chat/exercise-generation/exercise-grading
// paths, all of which only ever take at most one image, and none of them
// need to change to support this.
export async function getGradingReply(params: {
  systemPrompt: string;
  images: ImageAttachment[];
  maxTokens: number;
  event: LlmCallContext;
  tier: LlmTier;
  // See getChatReply's own comment.
  provider?: LlmProvider;
}): Promise<LlmReply> {
  const { event, tier, provider: requestedProvider, ...providerParams } =
    params;
  const provider = requestedProvider ?? getActiveLlmProvider();
  const model = resolveModel(provider, tier);
  const startedAt = Date.now();
  const reply =
    provider === "azure-openai"
      ? await getAzureOpenAIGradingReply({ ...providerParams, model })
      : provider === "gemini"
        ? // tier is passed through here (unlike the other two providers,
          // which have no thinking-budget concept) -- see
          // getGeminiGradingReply's own comment on why leaving it out
          // left this path just as exposed to silent truncation as the
          // chat path was before that was fixed, and arguably worse here:
          // this is a live judgment on a real student's answer sheet.
          await getGeminiGradingReply({ ...providerParams, model, tier })
        : await getAnthropicGradingReply({ ...providerParams, model });
  reportLlmCall(event, provider, reply, startedAt);
  return reply;
}
