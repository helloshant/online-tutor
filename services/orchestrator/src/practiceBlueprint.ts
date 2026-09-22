import type { ExerciseType } from "./types.js";

// A student picking their own question counts/marks per type was
// deliberately ruled out for v1 (see the accompanying plan) -- this fixed
// blueprint is what /v1/practice-paper/generate builds a paper from
// instead. Long-answer stays fixed at 2 regardless of chapter count: a
// paper never needs more than 2 deep-dive questions, keeping both
// generation cost and the number of photographed pages a student needs to
// write bounded.
export const MAX_CHAPTERS_PER_PAPER = 4;

export type BlueprintSection = {
  type: ExerciseType;
  count: number;
  marksEach: number;
};

export function buildPracticeBlueprint(chapterCount: number): BlueprintSection[] {
  const extra = Math.max(0, Math.min(chapterCount, MAX_CHAPTERS_PER_PAPER) - 1);
  return [
    { type: "MCQ", count: 5 + extra, marksEach: 1 },
    { type: "short_answer", count: 3 + extra, marksEach: 2 },
    { type: "long_answer", count: 2, marksEach: 5 },
  ];
}
