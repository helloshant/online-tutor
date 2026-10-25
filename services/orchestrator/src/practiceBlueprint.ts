import type { ExerciseType } from "./types.js";

// Was a single hardcoded composition (see git history) -- a student
// choosing their own question-type mix was explicitly out of scope for
// v1. Reported directly as wanted after all: "options to select how much
// percentage of the topics should be MCQ, Short answer, and Long Answer,"
// plus a Numerical option for Physics/Chemistry-type subjects (see
// practice-panel.tsx's own NUMERICAL_SUBJECT_CODES), and -- a follow-up
// report -- the total question count itself. Default stays 41 (the
// original hardcoded blueprint's own total) for a caller that doesn't ask
// for a specific count; MIN/MAX bound what a caller CAN ask for, mirrored
// in practice-panel.tsx's own number input and re-validated in
// /api/practice-papers' own route -- generation is 1 LLM call per
// question at bounded concurrency (see server.ts's own CONCURRENCY), so
// an unbounded count would be an unbounded-length, unbounded-cost request.
export const DEFAULT_PRACTICE_PAPER_QUESTIONS = 41;
export const MIN_PRACTICE_PAPER_QUESTIONS = 10;
export const MAX_PRACTICE_PAPER_QUESTIONS = 60;

// Real CBSE Grade 10 board-exam section types, reported directly as
// wanted in the type-mix picker: MCQ/short_answer/long_answer/numerical
// (the original 4, see ExerciseType's own comment) stay exactly as they
// were -- 'sa' (Short Answer, 3 marks, distinct from the existing
// 'short_answer', which the picker now relabels "VSA" at 2 marks),
// 'assertion_reasoning' (1 mark, fixed 4-option format), and 'case_study'
// (a shared scenario split into 3 independently-graded sub-parts worth
// 1+1+2 marks) are new. Deliberately its OWN union, not folded into the
// app-wide ExerciseType used by topic-practice/pattern-picker/chat/the
// archetype miner -- confirmed directly that answered_questions has no
// `type` column at all (ExerciseItem.type is generation-time metadata
// only, never persisted to the shared answer bank), so there's no shared
// schema these three would need to fit into, and widening the app-wide
// type would only risk silent gaps in the several exhaustive per-type
// switches elsewhere (describeTypeAsk, EXERCISE_TYPE_LABELS, ...) that
// have nothing to do with practice papers.
export type PracticePaperQuestionType =
  | ExerciseType
  | "sa"
  | "assertion_reasoning"
  | "case_study";

export type BlueprintSection = {
  type: PracticePaperQuestionType;
  // For every type except case_study, the number of questions. For
  // case_study, the number of SCENARIOS -- each one is 3 sub-part
  // questions (1+1+2 marks), not 1 -- see buildCaseStudySections below.
  count: number;
  // For case_study this is the TOTAL per scenario (1+1+2=4), for display/
  // reference only -- server.ts's own case-study job handler uses the
  // fixed CASE_STUDY_SUBPART_MARKS below for each sub-part's real mark
  // value, not this.
  marksEach: number;
};

// How many marks one question of each type is worth. MCQ/short/long match
// the original hardcoded blueprint's own weights exactly (1/2/5) --
// numerical sits between short and long: a worked derivation, which takes
// more than a quick short-answer response but is rarely as long as a full
// long-answer essay-style one. sa (3) sits between VSA/short_answer (2)
// and LA/long_answer (5) -- more structured working than VSA, short of a
// full derivation. assertion_reasoning (1) is MCQ-shaped: one quick,
// exact-match pick.
const MARKS_EACH: Record<PracticePaperQuestionType, number> = {
  MCQ: 1,
  short_answer: 2,
  long_answer: 5,
  numerical: 3,
  sa: 3,
  assertion_reasoning: 1,
  case_study: 4,
};

// Real CBSE Grade 10 Mathematics case-study sub-part marks (1+1+2=4) --
// fixed, not student-configurable, same as every other type's own
// MARKS_EACH weight.
export const CASE_STUDY_SUBPART_MARKS: [number, number, number] = [1, 1, 2];

// The original, pre-mix composition (20 MCQ + 15 short + 6 long = 41
// questions, 80 marks) -- also exactly what a caller that doesn't pass a
// questionMix at all still gets, unchanged from before this feature. Only
// the original 4 types -- sa/assertion_reasoning/case_study are opt-in
// only, never part of the no-mix default.
const DEFAULT_COUNTS: Record<ExerciseType, number> = {
  MCQ: 20,
  short_answer: 15,
  long_answer: 6,
  numerical: 0,
};

// Percentage (0-100) of the paper's total question count that should be
// each type -- see practice-panel.tsx's own picker. Missing keys are
// treated as 0%; the percentages don't need to sum to exactly 100 (see
// apportion's own comment) -- the web app's own route validates that
// before this is ever called, this is just defensive.
export type QuestionMix = Partial<Record<PracticePaperQuestionType, number>>;

// Converts a percentage mix into actual counts that always sum to exactly
// `total` -- a straight percentage multiply almost never lands on a whole
// number for every type at once (e.g. 50% of 41 is 20.5). Floors every
// share first, then hands the few leftover slots to whichever types had
// the largest fractional remainder -- the "largest remainder" / Hamilton
// apportionment method, the standard way to round a set of percentages to
// whole counts that still sum to the right total. Generic over whichever
// types are in `mix` -- used both for the ordinary apportionment below AND
// (with just MCQ/sa/etc. minus case_study) for case_study's own rebalance.
function apportion<T extends string>(
  mix: Record<T, number>,
  total: number,
): Record<T, number> {
  const types = Object.keys(mix) as T[];
  const raw = types.map((t) => (mix[t] / 100) * total);
  const floors = raw.map(Math.floor);
  const counts = Object.fromEntries(
    types.map((t, i) => [t, floors[i]]),
  ) as Record<T, number>;

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

// questionMix AND totalQuestions both omitted reproduces the original
// hardcoded blueprint exactly, byte for byte -- no behavior change for a
// caller that predates this feature. When questionMix is given,
// percentages are normalized to sum to 100 first (a slightly-off client
// total -- 99 or 101 from rounding in the picker UI -- shouldn't silently
// produce a short or long paper) and apportioned across totalQuestions
// (clamped to [MIN_PRACTICE_PAPER_QUESTIONS, MAX_PRACTICE_PAPER_QUESTIONS],
// defaulting to DEFAULT_PRACTICE_PAPER_QUESTIONS when omitted -- the web
// app's own route already enforces these same bounds before this is ever
// called, this is just defensive). totalQuestions given WITHOUT a
// questionMix is ignored -- there's no mix to scale against, and
// DEFAULT_COUNTS' own fixed 41 is what "no mix" has always meant.
export function buildPracticeBlueprint(
  questionMix?: QuestionMix,
  totalQuestions?: number,
): BlueprintSection[] {
  if (!questionMix) {
    return (Object.entries(DEFAULT_COUNTS) as [ExerciseType, number][])
      .filter(([, count]) => count > 0)
      .map(([type, count]) => ({ type, count, marksEach: MARKS_EACH[type] }));
  }
  const counts = apportionFromMix(questionMix, totalQuestions);
  return (Object.entries(counts) as [PracticePaperQuestionType, number][])
    .filter(([, count]) => count > 0)
    .map(([type, count]) => ({ type, count, marksEach: MARKS_EACH[type] }));
}

const ALL_TYPES: PracticePaperQuestionType[] = [
  "MCQ",
  "short_answer",
  "long_answer",
  "numerical",
  "sa",
  "assertion_reasoning",
  "case_study",
];

function apportionFromMix(
  questionMix: QuestionMix,
  totalQuestions?: number,
): Record<PracticePaperQuestionType, number> {
  const full = Object.fromEntries(
    ALL_TYPES.map((t) => [t, questionMix[t] ?? 0]),
  ) as Record<PracticePaperQuestionType, number>;
  const sum = Object.values(full).reduce((a, b) => a + b, 0);
  // Every percentage was zero/missing (a malformed or empty request) --
  // falls back to the original composition rather than apportioning
  // against a zero sum, which would divide by zero. sa/assertion_reasoning/
  // case_study explicitly zeroed out -- DEFAULT_COUNTS itself only ever
  // carries the original 4 types, by design (see its own comment).
  if (sum <= 0) {
    return {
      ...DEFAULT_COUNTS,
      sa: 0,
      assertion_reasoning: 0,
      case_study: 0,
    };
  }

  const normalized = Object.fromEntries(
    (Object.entries(full) as [PracticePaperQuestionType, number][]).map(
      ([t, v]) => [t, (v / sum) * 100],
    ),
  ) as Record<PracticePaperQuestionType, number>;

  const clampedTotal =
    totalQuestions && Number.isFinite(totalQuestions)
      ? Math.max(
          MIN_PRACTICE_PAPER_QUESTIONS,
          Math.min(MAX_PRACTICE_PAPER_QUESTIONS, Math.round(totalQuestions)),
        )
      : DEFAULT_PRACTICE_PAPER_QUESTIONS;

  const counts = apportion(normalized, clampedTotal);

  // case_study consumes 3 question SLOTS per scenario (1+1+2 marks), not
  // 1 -- apportioned above like any other type (a percentage share of
  // total slots, so its own share genuinely reflects "this fraction of
  // the paper's questions"), but a slot count isn't usable directly: it
  // has to land on a multiple of 3 (whole scenarios) before it can become
  // a scenario count. Rounds to the nearest multiple of 3, with a floor
  // of 3 (one whole scenario) whenever the student asked for ANY nonzero
  // case_study share -- a tiny percentage silently rounding to 0 would
  // drop a type they explicitly turned on. The resulting +/- slot
  // difference is then taken from (or given to) whichever OTHER type
  // currently has the largest count, so the grand total still lands close
  // to what was asked -- the one place a generated paper's real total can
  // drift slightly from the requested totalQuestions, same honest
  // trade-off this feature already makes for total marks no longer being
  // a fixed 80.
  const caseStudySlots = counts.case_study;
  if (caseStudySlots > 0) {
    const scenarios = Math.max(1, Math.round(caseStudySlots / 3));
    const roundedSlots = scenarios * 3;
    const delta = roundedSlots - caseStudySlots;
    if (delta !== 0) {
      const otherTypes = ALL_TYPES.filter((t) => t !== "case_study");
      const largest = otherTypes.reduce((a, b) =>
        counts[b] > counts[a] ? b : a,
      );
      counts[largest] = Math.max(0, counts[largest] - delta);
    }
    counts.case_study = scenarios;
  }

  return counts;
}
