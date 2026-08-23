// Rephrase-before-store safeguard for the chat answer bank -- see
// buildQuestionRestatementPrompt's own comment in prompts.ts for the full
// reasoning. Only ever called from /v1/chat's answer-bank write path in
// server.ts, immediately before recordAnswer -- never in the student-facing
// reply path itself, so a slow or failed call here can never delay or break
// the reply the student already received.
import { getChatReply } from "./llm.js";
import { buildQuestionRestatementPrompt } from "./prompts.js";

// Short -- this is a one-to-three-sentence restatement, not an explanation.
const RESTATEMENT_MAX_TOKENS = 150;

// Returns null on any failure (network error, empty/malformed response) --
// deliberately NOT falling back to the original question text. Every other
// best-effort write in this pipeline (cache.ts, answerBank.ts) fails open,
// since the worst case there is just a missed optimization. This is the one
// place fail-open would be the wrong default: silently storing the exact
// text this function exists to avoid storing would defeat the entire point
// the moment the safeguard itself has a bad day. The caller's job is to
// skip the answer-bank write entirely when this returns null, not to fall
// back to anything.
export async function restateQuestionForStorage(question: string): Promise<string | null> {
  const trimmed = question.trim();
  if (!trimmed) return null;

  try {
    const { text } = await getChatReply({
      systemPrompt: buildQuestionRestatementPrompt(),
      history: [],
      message: trimmed,
      maxTokens: RESTATEMENT_MAX_TOKENS,
    });
    const restated = text.trim();
    return restated || null;
  } catch (err) {
    console.error("Question restatement failed -- skipping answer-bank write for this question:", err);
    return null;
  }
}
