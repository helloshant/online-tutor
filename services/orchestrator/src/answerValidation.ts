// Gate on every LLM-generated answer before it's allowed into the shared
// answer bank. Deliberately cheap and deterministic -- no extra LLM call --
// so this doesn't erode the "reduce LLM hits" goal the pipeline exists for.
//
// Three outcomes:
//   - don't store at all: empty, an echoed syllabus-rejection, or reads like
//     a question asked back at the student rather than an answer. Nothing
//     here is worth an admin's time to review.
//   - store as "pending_review": passes the minimum bar but is short or
//     hedges, so it's kept but not yet servable to other students until an
//     admin explicitly confirms it (see search_answer_bank).
//   - store as "auto_approved": confident enough to serve immediately.
import { SYLLABUS_REJECTION_MESSAGE } from "./syllabusGate.js";

export type AnswerValidation =
  | { store: false; reason: string }
  | { store: true; status: "auto_approved" | "pending_review"; reason?: string };

const MIN_LENGTH_TO_STORE = 40;
const MIN_LENGTH_FOR_AUTO_APPROVAL = 150;

const UNCERTAINTY_PHRASES = [
  "i'm not sure",
  "i am not sure",
  "i don't know",
  "i do not know",
  "i'm not certain",
  "i am not certain",
  "i cannot verify",
  "i can't verify",
  "i don't have enough information",
  "i do not have enough information",
  "as an ai",
  "i'm unable to",
  "i am unable to",
  "i cannot answer",
  "i can't answer",
  "i don't have access",
  "unable to determine",
  "i might be wrong",
  "i may be wrong",
  "double-check with your teacher",
  "double check with your teacher",
];

export function validateAnswerForStorage(answer: string): AnswerValidation {
  const trimmed = answer.trim();

  if (!trimmed || trimmed === SYLLABUS_REJECTION_MESSAGE) {
    return { store: false, reason: "empty or a syllabus-rejection message" };
  }
  if (trimmed.length < MIN_LENGTH_TO_STORE) {
    return { store: false, reason: "too short to be a substantive answer" };
  }
  // A short reply ending in "?" reads as the tutor asking the student
  // something back, not delivering an answer -- unsafe to replay verbatim
  // to a different student who happens to phrase the same question.
  if (trimmed.endsWith("?") && trimmed.length < 200) {
    return { store: false, reason: "looks like a clarifying question, not an answer" };
  }

  const lower = trimmed.toLowerCase();
  const hasHedge = UNCERTAINTY_PHRASES.some((phrase) => lower.includes(phrase));

  if (hasHedge) {
    return { store: true, status: "pending_review", reason: "hedging/uncertainty language" };
  }
  if (trimmed.length < MIN_LENGTH_FOR_AUTO_APPROVAL) {
    return { store: true, status: "pending_review", reason: "too short for auto-approval" };
  }
  return { store: true, status: "auto_approved" };
}
