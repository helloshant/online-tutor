// Parses the LLM's strict-JSON response to buildPracticePaperGradingPrompt
// (see prompts.ts's own OUTPUT section) into per-question numeric scores.
// Deliberately its own parser, not exerciseGrading.ts's plain-text
// Verdict:/Feedback: regex approach -- this needs an ARRAY of numeric
// per-question results, not one categorical verdict, so JSON is the more
// reliable shape to ask the model for and parse here.
export type PracticePaperGradingResult = {
  results: { id: string; score: number; feedback: string }[];
  overallFeedback: string;
};

const JSON_FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
const OUTERMOST_JSON_OBJECT = /\{[\s\S]*\}/;

function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(JSON_FENCE);
  const candidate = fenced ? fenced[1] : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // Fall through to a looser extraction below -- the model occasionally
    // wraps the JSON in a stray sentence despite being told not to.
  }

  const outer = candidate.match(OUTERMOST_JSON_OBJECT);
  if (!outer) return null;
  try {
    return JSON.parse(outer[0]);
  } catch {
    return null;
  }
}

// Never throws -- returns null on total parse failure (mirrors
// gradeExerciseAnswer's own "return null, let the caller decide" posture),
// so a single malformed grading response fails the request cleanly (the
// caller returns a 502 and the student can retry) rather than crashing the
// process.
//
// Every question the caller asked about always gets a result row, even if
// the model's own JSON omitted it -- a missing/unparseable per-question
// entry scores 0 with a generic feedback string rather than silently
// vanishing from the response the student sees. Every score is clamped to
// [0, question.marks] server-side -- the model is never trusted to respect
// its own cap.
export function parsePracticePaperGrading(
  text: string,
  questions: { id: string; marks: number }[],
): PracticePaperGradingResult | null {
  const parsed = extractJson(text);
  if (typeof parsed !== "object" || parsed === null) return null;

  const { results, overallFeedback } = parsed as {
    results?: unknown;
    overallFeedback?: unknown;
  };
  if (!Array.isArray(results)) return null;

  const byId = new Map<string, { score: number; feedback: string }>();
  for (const entry of results) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, score, feedback } = entry as {
      id?: unknown;
      score?: unknown;
      feedback?: unknown;
    };
    if (typeof id !== "string" || !id) continue;
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    byId.set(id, {
      score,
      feedback: typeof feedback === "string" ? feedback : "",
    });
  }

  const clampedResults = questions.map((q) => {
    const found = byId.get(q.id);
    if (!found) {
      return {
        id: q.id,
        score: 0,
        feedback: "Could not be graded automatically.",
      };
    }
    return {
      id: q.id,
      score: Math.max(0, Math.min(found.score, q.marks)),
      feedback: found.feedback || "Could not be graded automatically.",
    };
  });

  return {
    results: clampedResults,
    overallFeedback: typeof overallFeedback === "string" ? overallFeedback : "",
  };
}
