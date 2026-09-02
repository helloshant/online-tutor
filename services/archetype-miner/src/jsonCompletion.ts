import { getCompletion, type LlmProvider } from "./llm.js";
import type { PdfAttachment, TokenUsage } from "./llmTypes.js";

// Every stage prompt ends with "Return ONLY valid JSON ... No markdown, no
// explanatory prose" -- but a model occasionally wraps its answer in a
// ```json fence anyway despite that instruction, or (rarely) prepends a
// stray sentence. Stripping a wrapping fence is cheap insurance; anything
// else malformed is a real failure this surfaces rather than silently
// papers over, since every downstream stage trusts the shape it gets.
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

export class LlmJsonParseError extends Error {
  constructor(
    message: string,
    public readonly rawText: string
  ) {
    super(message);
    this.name = "LlmJsonParseError";
  }
}

const MAX_ATTEMPTS = 3;

// Anthropic's own value ("max_tokens") and Azure OpenAI's own value
// ("length") for "the response was cut off by the token budget, not
// because the model finished." A truncated response can still be
// perfectly valid JSON -- a model closing out an array/object early to
// land under its token budget, rather than getting cut off mid-token,
// produces exactly that: syntactically complete but silently missing most
// of the records it should have produced (confirmed directly: a 33-
// question paper's Segmenter call returned a valid 3-element array this
// way, no parse error, nothing to distinguish it from a paper that
// genuinely only had 3 segmentable questions). finishReason is the only
// signal that catches this -- record count alone can't, since there's no
// way to know in general how many records a given input SHOULD produce.
const TRUNCATED_FINISH_REASONS = new Set(["max_tokens", "length"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Calls the LLM and parses its response as JSON, retrying the WHOLE call
// (not just the parse) up to MAX_ATTEMPTS times on a parse failure or an
// empty response -- a malformed-JSON response is almost always a one-off
// model hiccup on a retry-prone task (long structured output), not
// something a second attempt at the identical prompt will reliably
// reproduce. Throws LlmJsonParseError (carrying the last raw response, for
// logging/debugging) if every attempt fails -- the caller's job is to fail
// that one unit of work (one question, one cluster) without taking the
// whole pipeline run down, see pipelineRunner.ts.
export async function getJsonCompletion(params: {
  systemPrompt: string;
  message: string;
  maxTokens: number;
  pdf?: PdfAttachment | null;
  provider?: LlmProvider;
}): Promise<{ data: unknown; model: string; usage: TokenUsage }> {
  let lastError: unknown;
  let lastRawText = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { text, model, usage, finishReason } = await getCompletion(params);
    lastRawText = text;
    if (!text.trim()) {
      lastError = new Error("Empty response from LLM");
    } else if (finishReason && TRUNCATED_FINISH_REASONS.has(finishReason)) {
      // Checked BEFORE attempting to parse -- see TRUNCATED_FINISH_REASONS'
      // own comment on why a truncated response can still parse cleanly,
      // which would otherwise let it through as if it were complete.
      lastError = new Error(
        `LLM response was truncated by the token budget (finish_reason: "${finishReason}") -- ` +
          "the output may still be valid JSON, but it's incomplete, not a genuine full response."
      );
    } else {
      try {
        const data = JSON.parse(stripCodeFence(text));
        return { data, model, usage };
      } catch (err) {
        lastError = err;
      }
    }
    if (attempt < MAX_ATTEMPTS) {
      await sleep(500 * attempt);
    }
  }

  throw new LlmJsonParseError(
    `Failed to parse JSON from LLM response after ${MAX_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    lastRawText
  );
}
