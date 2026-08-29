// Mirrors services/orchestrator/src/types.ts's own TokenUsage/LlmReply --
// this service's provider calls are simpler (one system prompt + one user
// message per stage call, no chat history; every stage is a single-shot
// structured-JSON request, not a conversation), so this is its own smaller
// version rather than importing the orchestrator's (each service in this
// repo is an independently deployable container with its own
// package.json/node_modules -- there's no shared workspace package to
// import from, same reasoning services/observability's own types.ts is
// separate from the orchestrator's).
export type TokenUsage = { promptTokens: number; completionTokens: number };

export type LlmReply = {
  text: string;
  model: string;
  usage: TokenUsage;
};

// Stage 0 (Segmenter) only -- lets a raw_papers submission hand the model
// an actual exam paper PDF instead of pre-extracted text, mirroring
// services/orchestrator/src/types.ts's own ImageAttachment for a screenshot
// question. Only Anthropic's Messages API supports a native PDF content
// block the way this needs (see anthropicProvider.ts); the Azure OpenAI
// provider rejects it rather than silently degrading (see
// azureOpenAIProvider.ts).
export type PdfAttachment = { mediaType: "application/pdf"; base64: string };
