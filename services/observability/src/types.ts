export type Medium = "English" | "Hindi" | "Bengali";
export type ChatEventMode = "student" | "staff";
export type ChatEventSource = "cache" | "database" | "llm" | "rejected";

// What the orchestrator reports after every /v1/chat request. Token/cost
// fields are required when source is "llm" and otherwise ignored -- a cache
// or database hit costs nothing and consumes no tokens.
export type ChatEventInput = {
  userId: string;
  mode: ChatEventMode;
  boardId?: string | null;
  gradeId?: string | null;
  subjectId: string;
  medium?: Medium | null;
  question: string;
  source: ChatEventSource;
  provider?: string | null;
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  answerBankId?: string | null;
  latencyMs?: number | null;
};
