import type { ExerciseType } from "./types.js";

// Parses the LLM's generated exercises (see EXERCISE_FORMAT_INSTRUCTIONS /
// EXERCISE_FORMAT_INSTRUCTIONS_WITH_PATTERN in prompts.ts) into
// question/solution pairs: exercises are separated by a line of three or
// more dashes, and within each block a line starting with "Q:" opens the
// question and "A:" opens the solution -- either may span multiple lines,
// so the markers are what's parsed on, not line breaks.
const EXERCISE_BLOCK_PATTERN = /^Q:\s*([\s\S]*?)\r?\n^A:\s*([\s\S]*)$/im;

// Only present when generation was archetype-grounded (see
// EXERCISE_FORMAT_INSTRUCTIONS_WITH_PATTERN) -- a trailing "Pattern: N"
// line naming which numbered pattern that exercise instantiates. Stripped
// off the block BEFORE the Q/A match above runs, as its own pre-processing
// step, rather than folded into EXERCISE_BLOCK_PATTERN itself: making the
// answer capture there lazy (needed to let an optional trailing group
// match after it) would make it stop at the FIRST line break inside a
// multi-line answer instead of the block's real end, silently truncating
// every worked solution that spans more than one line -- confirmed while
// writing this, not a hypothetical. Isolating this as a separate strip
// keeps the original, already-correct greedy Q/A pattern untouched.
const PATTERN_LINE = /\n^Pattern:\s*(\d+)\s*$/im;

// Present on EVERY exercise now (see EXERCISE_FORMAT_INSTRUCTIONS' own
// comment) -- always the LAST line of the block, after Pattern: when both
// are present, so it's stripped first (see the stripping order below).
// Same "strip before the greedy Q/A match runs" reasoning as PATTERN_LINE.
const TYPE_LINE = /\n^Type:\s*(\S+)\s*$/im;
const VALID_TYPES: ExerciseType[] = [
  "MCQ",
  "short_answer",
  "long_answer",
  "numerical",
];

// Case-insensitive match against the four real values -- anything else
// (the model drifting from the requested label, e.g. "Multiple Choice"
// instead of "MCQ") is simply left unclassified rather than guessed at;
// an exercise with no recognizable type is never dropped over this, only
// its own type badge stays absent.
function normalizeType(raw: string): ExerciseType | undefined {
  return VALID_TYPES.find((t) => t.toLowerCase() === raw.toLowerCase());
}

export type ParsedExercise = {
  question: string;
  answer: string;
  patternIndex?: number;
  type?: ExerciseType;
};

export function parseGeneratedExercises(text: string): ParsedExercise[] {
  // Normalize CRLF/CR up front -- see the identical fix and reasoning in
  // src/app/admin/answer-bank/actions.ts's parseImportBlocks, which this
  // function is deliberately kept in sync with.
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split(/\n-{3,}\n/);
  const rows: ParsedExercise[] = [];

  for (const rawBlock of blocks) {
    let block = rawBlock.trim();
    if (!block) continue;

    // Type: is stripped FIRST -- it's always the trailing-most special
    // line in the format (after Pattern: when both are present), so
    // removing it first leaves Pattern: as the new trailing-most line for
    // the strip below, regardless of which combination this block has.
    let type: ExerciseType | undefined;
    const typeMatch = block.match(TYPE_LINE);
    if (typeMatch) {
      type = normalizeType(typeMatch[1]);
      block = block.slice(0, typeMatch.index).trim();
    }

    let patternIndex: number | undefined;
    const patternMatch = block.match(PATTERN_LINE);
    if (patternMatch) {
      patternIndex = Number(patternMatch[1]);
      block = block.slice(0, patternMatch.index).trim();
    }

    const match = block.match(EXERCISE_BLOCK_PATTERN);
    if (!match) continue;
    const question = match[1].trim();
    const answer = match[2].trim();
    if (!question || !answer) continue;
    rows.push({
      question,
      answer,
      ...(patternIndex !== undefined && Number.isFinite(patternIndex)
        ? { patternIndex }
        : {}),
      ...(type ? { type } : {}),
    });
  }

  return rows;
}

// Parses buildCaseStudyGenerationPrompt's own fixed SCENARIO:/SUBPART N
// (M mark(s)):/Q:/A: format (prompts.ts) into a shared scenario plus its 3
// sub-parts, in order. Deliberately its own parser, not a reuse of
// parseGeneratedExercises above -- a case study is 4 pieces of text from
// ONE generation call (one scenario + 3 Q/A pairs), not N independent
// ----separated exercise blocks, so the format itself is genuinely
// different, not just a new Type: value within the existing one. Returns
// null on any structural mismatch (missing scenario, fewer than 3
// subparts) -- the caller treats that the same as any other generation
// failure, skipping this one case-study slot rather than storing a
// partial/malformed group.
const SCENARIO_LINE = /^SCENARIO:\s*([\s\S]*?)(?=\n^SUBPART\s+1\b)/im;
// The trailing alternative is (?![\s\S]), not a plain $ -- under the /m
// flag $ matches the end of EVERY line, not just the end of the string,
// which would make the lazy answer capture stop at the first line break
// inside the LAST subpart's own answer instead of the text's real end,
// silently truncating any multi-line solution -- same bug class
// EXERCISE_BLOCK_PATTERN's own comment above already warns about for the
// identical reason, confirmed here too while writing this.
const SUBPART_BLOCK = /^SUBPART\s+(\d+)\s*\([^)]*\):\s*\nQ:\s*([\s\S]*?)\r?\n^A:\s*([\s\S]*?)(?=\n^SUBPART\s+\d+\b|(?![\s\S]))/gim;

export type ParsedCaseStudy = {
  scenario: string;
  subparts: { question: string; answer: string }[];
};

export function parseCaseStudyGeneration(text: string): ParsedCaseStudy | null {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

  const scenarioMatch = normalized.match(SCENARIO_LINE);
  const scenario = scenarioMatch?.[1]?.trim();
  if (!scenario) return null;

  const subparts: { question: string; answer: string }[] = [];
  for (const match of normalized.matchAll(SUBPART_BLOCK)) {
    const question = match[2]?.trim();
    const answer = match[3]?.trim();
    if (!question || !answer) continue;
    subparts.push({ question, answer });
  }

  if (subparts.length < 3) return null;
  return { scenario, subparts: subparts.slice(0, 3) };
}

// Finds a `[EXERCISES]...[/EXERCISES]` block the tutor's own chat reply may
// contain (see buildTutorSystemPrompt's rule on this -- used only when the
// student explicitly asks for practice exercises mid-conversation, as
// opposed to the dedicated topic-exercise generation endpoints) and parses
// its contents with the exact same Q:/A:/--- format as everywhere else.
// This is what lets a freeform "give me some Voice Change exercises" chat
// request end up just as structurally trackable as an exercise batch from
// the pattern picker -- confirmed live as the fix for a real report: a
// student's "answer 3" follow-up got answered against a completely
// different, OLDER structured batch than the freeform one just given,
// because the freeform batch existed only as plain prose with nothing for
// the exercise-context follow-up logic (see the web app's chat-panel.tsx)
// to find.
//
// Returns the original text completely unchanged, tag included, when no
// block is found OR the block is found but doesn't parse into at least one
// exercise (a malformed/empty block) -- never silently drops real content
// the way stripping an unparseable block would. Only ever strips the block
// out of `text` once there's real parsed content to show in its place.
const EXERCISES_BLOCK_PATTERN = /\[EXERCISES\]([\s\S]*?)\[\/EXERCISES\]/i;

export function extractEmbeddedExercises(text: string): {
  text: string;
  exercises: ParsedExercise[];
} {
  const match = text.match(EXERCISES_BLOCK_PATTERN);
  if (!match) return { text, exercises: [] };

  const exercises = parseGeneratedExercises(match[1]);
  if (exercises.length === 0) return { text, exercises: [] };

  // Collapses any blank lines left behind where the block used to sit, so
  // the surrounding prose reads as one continuous reply rather than
  // leaving a visible gap.
  const cleaned = (text.slice(0, match.index) + text.slice(match.index! + match[0].length))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: cleaned, exercises };
}
