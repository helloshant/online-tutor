import type { ExerciseType } from "./types.js";

// Was a single hardcoded composition (see git history) -- a student
// choosing their own question-type mix was explicitly out of scope for
// v1. Reported directly as wanted after all: "options to select how much
// percentage of the topics should be MCQ, Short answer, and Long Answer,"
// plus a Numerical option for Physics/Chemistry-type subjects (see
// practice-panel.tsx's own NUMERICAL_SUBJECT_CODES). What's still fixed,
// preserving the "reads like a real, fixed-length mock exam" property the
// original hardcoded blueprint cared about (see this file's own git
// history): the total QUESTION COUNT, not total marks -- marks now vary
// with whichever mix a student picks, same as a real exam's total would
// if you swapped its own section weights around.
export const PRACTICE_PAPER_TOTAL_QUESTIONS = 41;

export type BlueprintSection = {
  type: ExerciseType;
  count: number;
  marksEach: number;
};

// How many marks one question of each type is worth. MCQ/short/long match
// the original hardcoded blueprint's own weights exactly (1/2/5) --
// numerical sits between short and long: a worked derivation, which takes
// more than a quick short-answer response but is rarely as long as a full
// long-answer essay-style one.
const MARKS_EACH: Record<ExerciseType, number> = {
  MCQ: 1,
  short_answer: 2,
  long_answer: 5,
  numerical: 3,
};

// The original, pre-mix composition (20 MCQ + 15 short + 6 long = 41
// questions, 80 marks) -- also exactly what a caller that doesn't pass a
// questionMix at all still gets, unchanged from before this feature.
const DEFAULT_COUNTS: Record<ExerciseType, number> = {
  MCQ: 20,
  short_answer: 15,
  long_answer: 6,
  numerical: 0,
};

// Percentage (0-100) of the paper's fixed total question count that should
// be each type -- see practice-panel.tsx's own picker. Missing keys are
// treated as 0%; the percentages don't need to sum to exactly 100 (see
// apportion's own comment) -- the web app's own route validates that
// before this is ever called, this is just defensive.
export type QuestionMix = Partial<Record<ExerciseType, number>>;

// Converts a percentage mix into actual question counts that always sum to
// exactly `total` -- a straight percentage multiply almost never lands on
// a whole number for every type at once (e.g. 50% of 41 is 20.5). Floors
// every share first, then hands the few leftover slots to whichever types
// had the largest fractional remainder -- the "largest remainder" /
// Hamilton apportionment method, the standard way to round a set of
// percentages to whole counts that still sum to the right total.
function apportion(
  mix: Record<ExerciseType, number>,
  total: number,
): Record<ExerciseType, number> {
  const types = Object.keys(mix) as ExerciseType[];
  const raw = types.map((t) => (mix[t] / 100) * total);
  const floors = raw.map(Math.floor);
  const counts = Object.fromEntries(
    types.map((t, i) => [t, floors[i]]),
  ) as Record<ExerciseType, number>;

  let allocated = floors.reduce((a, b) => a + b, 0);
  const byRemainderDesc = types
    .map((t, i) => ({ type: t, remainder: raw[i] - floors[i] }))
    .sort((a, b) => b.remainder - a.remainder);

  let i = 0;
  while (allocated < total && byRemainderDesc.length > 0) {
    counts[byRemainderDesc[i % byRemainderDesc.length].type] += 1;
    allocated += 1;
    i += 1;
  }
  return counts;
}

// questionMix omitted entirely reproduces the original hardcoded blueprint
// exactly, byte for byte -- no behavior change for a caller that predates
// this feature. When given, percentages are normalized to sum to 100
// first (a slightly-off client total -- 99 or 101 from rounding in the
// picker UI -- shouldn't silently produce a 40 or 42-question paper) and
// apportioned across the fixed total question count above.
export function buildPracticeBlueprint(questionMix?: QuestionMix): BlueprintSection[] {
  const counts = questionMix ? apportionFromMix(questionMix) : DEFAULT_COUNTS;
  return (Object.entries(counts) as [ExerciseType, number][])
    .filter(([, count]) => count > 0)
    .map(([type, count]) => ({ type, count, marksEach: MARKS_EACH[type] }));
}

function apportionFromMix(questionMix: QuestionMix): Record<ExerciseType, number> {
  const full: Record<ExerciseType, number> = {
    MCQ: questionMix.MCQ ?? 0,
    short_answer: questionMix.short_answer ?? 0,
    long_answer: questionMix.long_answer ?? 0,
    numerical: questionMix.numerical ?? 0,
  };
  const sum = Object.values(full).reduce((a, b) => a + b, 0);
  // Every percentage was zero/missing (a malformed or empty request) --
  // falls back to the original composition rather than apportioning
  // against a zero sum, which would divide by zero.
  if (sum <= 0) return DEFAULT_COUNTS;

  const normalized = Object.fromEntries(
    (Object.entries(full) as [ExerciseType, number][]).map(([t, v]) => [
      t,
      (v / sum) * 100,
    ]),
  ) as Record<ExerciseType, number>;

  return apportion(normalized, PRACTICE_PAPER_TOTAL_QUESTIONS);
}
