// Keeps the tutor's system prompt cheap as syllabi grow to full size: instead
// of dumping every topic's description into every request, only topics that
// share keywords with the current question get full detail. The chapter
// list (much shorter than full topic descriptions) is always included in
// full separately, so the model still knows the complete scope even when a
// question doesn't keyword-match anything specific.
import type { SyllabusTopic } from "./types.js";

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "of", "in", "on", "at",
  "to", "for", "and", "or", "but", "with", "about", "what", "why", "how", "who", "when", "where",
  "which", "this", "that", "these", "those", "i", "you", "he", "she", "it", "we", "they", "my",
  "your", "his", "her", "its", "our", "their", "do", "does", "did", "can", "could", "should",
  "would", "will", "shall", "explain", "please", "tell", "me", "show", "give", "example",
  "examples", "question", "questions", "problem", "solve", "find", "calculate",
]);

// Unicode-aware: \p{L}/\p{N} match letters/numbers in any script (Bengali,
// Devanagari, Latin, ...), not just a-z0-9. A plain ASCII split here would
// silently tokenize Bengali/Hindi text to nothing -- every character in
// those scripts would be treated as a separator -- which would make this
// gate a no-op for any non-Latin-script syllabus/question. \p{M} (combining
// marks) must stay in the "keep" set too: Bengali/Devanagari conjuncts are
// built from a base letter plus combining vowel signs/virama, which are
// category Mark, not Letter -- excluding them would fracture every
// multi-syllable word at each vowel sign instead of tokenizing whole words.
const WORD_SPLIT_PATTERN = /[^\p{L}\p{N}\p{M}]+/u;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(WORD_SPLIT_PATTERN)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

// Below this many topics, filtering isn't worth the complexity -- just
// include everything, same as before.
const FILTER_THRESHOLD = 25;
const MAX_RELEVANT_TOPICS = 15;

export function selectRelevantTopics<T extends SyllabusTopic>(
  topics: T[],
  message: string,
  limit: number = MAX_RELEVANT_TOPICS
): T[] {
  if (topics.length <= FILTER_THRESHOLD) return topics;

  const queryWords = new Set(tokenize(message));
  if (queryWords.size === 0) return topics.slice(0, limit);

  const scored = topics
    .map((topic) => {
      const words = tokenize(`${topic.chapter} ${topic.topic}`);
      const score = words.reduce((acc, word) => acc + (queryWords.has(word) ? 1 : 0), 0);
      return { topic, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return topics.slice(0, limit);
  return scored.slice(0, limit).map((entry) => entry.topic);
}

// Best single-topic guess for a question -- powers the "Practice a
// specific pattern" picker on ordinary chat replies (not just topic-
// summary bubbles, which already know their own topic statically). A
// deliberately separate function from selectRelevantTopics above, not a
// reuse of its top result: that function short-circuits below
// FILTER_THRESHOLD (returns every topic unscored, since trimming the
// prompt isn't worth the complexity at that size) -- fine for its own
// job (bounding prompt size), wrong for this one, since "which ONE topic
// is this about" matters at any syllabus size, including small ones.
// Returns null on zero shared keywords -- an unconfident guess would
// show a picker for the wrong topic, which is worse than showing none.
export function bestMatchingTopic<T extends SyllabusTopic>(topics: T[], message: string): T | null {
  const queryWords = new Set(tokenize(message));
  if (queryWords.size === 0) return null;

  let best: T | null = null;
  let bestScore = 0;
  for (const topic of topics) {
    const words = tokenize(`${topic.chapter} ${topic.topic}`);
    const score = words.reduce((acc, word) => acc + (queryWords.has(word) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = topic;
    }
  }
  return best;
}
