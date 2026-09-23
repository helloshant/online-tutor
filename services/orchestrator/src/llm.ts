import {
  getAnthropicReply,
  getAnthropicGradingReply,
} from "./anthropicProvider.js";
import {
  getAzureOpenAIReply,
  getAzureOpenAIGradingReply,
} from "./azureOpenAIProvider.js";
import { recordChatEvent } from "./observabilityClient.js";
import type { ChatTurn, ImageAttachment, LlmReply, Medium } from "./types.js";

export type LlmProvider = "anthropic" | "azure-openai";

// Defaults to Anthropic; set LLM_PROVIDER=azure-openai to switch.
export function getActiveLlmProvider(): LlmProvider {
  return process.env.LLM_PROVIDER === "azure-openai"
    ? "azure-openai"
    : "anthropic";
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
  reply: LlmReply,
  startedAt: number,
): void {
  if (!context.loggable) return;
  // Fire-and-forget, same posture as every recordChatEvent call this
  // replaces -- observability is an add-on to the pipeline, not a
  // dependency of it, so this never adds latency to the reply the caller is
  // about to return.
  void recordChatEvent({
    userId: context.userId,
    mode: context.mode,
    boardId: context.boardId,
    gradeId: context.gradeId,
    subjectId: context.subjectId,
    medium: context.medium,
    question: context.question,
    source: "llm",
    provider: getActiveLlmProvider(),
    model: reply.model,
    promptTokens: reply.usage.promptTokens,
    completionTokens: reply.usage.completionTokens,
    latencyMs: Date.now() - startedAt,
    grounded: context.grounded,
  });
}

export async function getChatReply(params: {
  systemPrompt: string;
  history: ChatTurn[];
  message: string;
  maxTokens: number;
  image?: ImageAttachment | null;
  event: LlmCallContext;
}): Promise<LlmReply> {
  const { event, ...providerParams } = params;
  const startedAt = Date.now();
  const reply =
    getActiveLlmProvider() === "azure-openai"
      ? await getAzureOpenAIReply(providerParams)
      : await getAnthropicReply(providerParams);
  reportLlmCall(event, reply, startedAt);
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
}): Promise<LlmReply> {
  const { event, ...providerParams } = params;
  const startedAt = Date.now();
  const reply =
    getActiveLlmProvider() === "azure-openai"
      ? await getAzureOpenAIGradingReply(providerParams)
      : await getAnthropicGradingReply(providerParams);
  reportLlmCall(event, reply, startedAt);
  return reply;
}
