// Mirrors services/orchestrator/src/types.ts's own TokenUsage/LlmReply --
// this service's provider calls are simpler (one system prompt + one user
// message per stage call, no chat history, no image input; every stage is
// a single-shot structured-JSON request, not a conversation), so this is
// its own smaller version rather than importing the orchestrator's (each
// service in this repo is an independently deployable container with its
// own package.json/node_modules -- there's no shared workspace package to
// import from, same reasoning services/observability's own types.ts is
// separate from the orchestrator's).
export type TokenUsage = { promptTokens: number; completionTokens: number };

export type LlmReply = {
  text: string;
  model: string;
  usage: TokenUsage;
};
