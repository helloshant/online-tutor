// Grades a student's own attempt at a practice exercise, submitted before
// they've seen the worked solution (see topic-summary-message.tsx and
// buildGradingPrompt in prompts.ts). An LLM judge, not exact-string
// matching, is the only thing that works here: a correct open-ended math/
// science answer can legitimately be phrased, worked, or rounded
// differently than the stored solution, and this needs to recognize a
// genuinely different-but-valid method as correct, not just a literal
// match.
import { buildGradingPrompt } from "./prompts.js";
import { getChatReply } from "./llm.js";
import type { ExerciseVerdict, Medium } from "./types.js";

const MAX_TOKENS = 400;
const VALID_VERDICTS: ExerciseVerdict[] = ["correct", "partially_correct", "incorrect"];

// Deliberately its own tiny parser, not jsonCompletion.ts's JSON path --
// grading output is two plain-text lines (see buildGradingPrompt's own
// OUTPUT section), not a JSON structure, so there's nothing for that
// module's retry-then-throw machinery to add here that a direct regex
// match doesn't already cover just as well.
const VERDICT_LINE = /verdict:\s*(correct|partially_correct|incorrect)/i;
const FEEDBACK_LINE = /feedback:\s*([\s\S]*)/i;

// null means the model's response couldn't be parsed into a real verdict
// -- the caller (server.ts) still reveals the real stored solution either
// way, but explicitly does NOT record a correctness signal into
// student_archetype_progress when this happens, rather than guessing and
// contaminating the mastery data with a fabricated result.
export async function gradeExerciseAnswer(params: {
  subjectName: string;
  medium: Medium;
  responseLanguage?: Medium;
  question: string;
  expectedAnswer: string;
  studentAnswer: string;
}): Promise<{ verdict: ExerciseVerdict; feedback: string } | null> {
  const systemPrompt = buildGradingPrompt(params);
  const { text } = await getChatReply({
    systemPrompt,
    history: [],
    message: "Grade this attempt now.",
    maxTokens: MAX_TOKENS,
  });

  const verdictMatch = text.match(VERDICT_LINE);
  const feedbackMatch = text.match(FEEDBACK_LINE);
  const verdict = verdictMatch?.[1]?.toLowerCase() as ExerciseVerdict | undefined;
  const feedback = feedbackMatch?.[1]?.trim();

  if (!verdict || !VALID_VERDICTS.includes(verdict) || !feedback) {
    console.warn("Could not parse a grading verdict from the LLM response:", text.slice(0, 300));
    return null;
  }

  return { verdict, feedback };
}
