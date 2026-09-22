import type { ExerciseType } from "./types.js";

// A student picking their own question counts/marks per type was
// deliberately ruled out for v1 (see the accompanying plan) -- this fixed
// blueprint is what /v1/practice-paper/generate builds a paper from
// instead. Reported directly: an earlier version scaled a small question
// set by how many chapters were selected, which made the paper's own
// total marks vary (21-30ish) instead of reading like a real, fixed-length
// mock exam -- this is now a full-length, CBSE-style composition (20 MCQ +
// 15 short-answer + 6 long-answer) that always totals exactly 80 marks,
// regardless of how many chapters a student selected. Selection size
// itself still has no cap (a student can pick the whole syllabus) -- see
// server.ts's own comment on how a large selection still gets varied
// coverage across this same fixed question count (topics are shuffled
// before the round-robin draw, not just the first few in array order).
export const PRACTICE_PAPER_TOTAL_MARKS = 80;

export type BlueprintSection = {
  type: ExerciseType;
  count: number;
  marksEach: number;
};

export function buildPracticeBlueprint(): BlueprintSection[] {
  return [
    { type: "MCQ", count: 20, marksEach: 1 },
    { type: "short_answer", count: 15, marksEach: 2 },
    { type: "long_answer", count: 6, marksEach: 5 },
  ];
}
