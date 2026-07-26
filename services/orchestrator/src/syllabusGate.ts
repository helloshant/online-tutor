// Stage 1 of the answer pipeline: decide whether a student's question is
// plausibly about their subscribed subject/board/grade syllabus *before*
// spending a cache lookup, a database query, or an LLM call on it. This is
// deliberately a lenient keyword-overlap heuristic, not a classifier -- the
// cost of a false rejection (a legitimate question refused) is worse than
// the cost of a false acceptance (an off-topic question reaching the LLM,
// which still enforces subject/syllabus boundaries in its system prompt).
import { tokenize } from "./syllabusFilter.js";
import type { ChatTurn, SyllabusTopic } from "./types.js";

export const SYLLABUS_REJECTION_MESSAGE = "Please restrict your questions to your syllabus";

// Below this many meaningful tokens, a message is treated as conversational
// ("hi", "can you help me", "give me another example") rather than a
// substantive question, and let through without a keyword match.
const MIN_TOKENS_TO_JUDGE = 3;

export function isQuestionInSyllabus(params: {
  subjectName: string;
  topics: SyllabusTopic[];
  message: string;
  history: ChatTurn[];
}): boolean {
  const { subjectName, topics, message, history } = params;

  // No syllabus loaded for this board/grade/subject yet -- nothing to gate
  // against, so don't block the student on a catalog gap.
  if (topics.length === 0) return true;

  // Mid-conversation follow-ups ("why?", "give another example", "explain
  // that differently") legitimately have no keyword overlap with the
  // syllabus on their own; only gate on the opening message of a topic.
  if (history.length > 0) return true;

  const queryWords = tokenize(message);
  if (queryWords.length < MIN_TOKENS_TO_JUDGE) return true;

  const syllabusWords = new Set<string>([
    ...tokenize(subjectName),
    ...topics.flatMap((t) => tokenize(`${t.chapter} ${t.topic}`)),
  ]);

  return queryWords.some((word) => syllabusWords.has(word));
}
