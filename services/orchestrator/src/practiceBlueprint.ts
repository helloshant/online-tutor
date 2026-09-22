import type { ExerciseType } from "./types.js";

// A student picking their own question counts/marks per type was
// deliberately ruled out for v1 (see the accompanying plan) -- this fixed
// blueprint is what /v1/practice-paper/generate builds a paper from
// instead. Long-answer stays fixed at 2 regardless of chapter count: a
// paper never needs more than 2 deep-dive questions, keeping both
// generation cost and the number of photographed pages a student needs to
// write bounded.
//
// A student can select as many chapters as they want -- even the whole
// syllabus -- with no cap on the selection itself (reported directly: an
// earlier version capped the picker at 4 chapters, which was unwanted).
// This constant is NOT that cap; it only bounds how much the paper's own
// SIZE scales with a large selection, so picking 20 chapters still
// produces one reasonably-sized mock paper (same LLM call count as
// picking 4) rather than an enormous one -- see server.ts's own comment on
// how a large selection still gets varied coverage despite this cap
// (the topics drawn from are shuffled first, not just the first few).
export const MAX_BLUEPRINT_SCALE_CHAPTERS = 4;

export type BlueprintSection = {
  type: ExerciseType;
  count: number;
  marksEach: number;
};

export function buildPracticeBlueprint(
  chapterCount: number,
): BlueprintSection[] {
  const extra = Math.max(
    0,
    Math.min(chapterCount, MAX_BLUEPRINT_SCALE_CHAPTERS) - 1,
  );
  return [
    { type: "MCQ", count: 5 + extra, marksEach: 1 },
    { type: "short_answer", count: 3 + extra, marksEach: 2 },
    { type: "long_answer", count: 2, marksEach: 5 },
  ];
}
