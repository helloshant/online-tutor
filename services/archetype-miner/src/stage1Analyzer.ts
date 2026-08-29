import { getJsonCompletion } from "./jsonCompletion.js";
import { buildAnalyzerPrompt } from "./prompts.js";
import type { QuestionSignature, SegmentedQuestion } from "./types.js";

const MAX_TOKENS = 2000;

function isValidQuestionSignature(value: unknown): value is QuestionSignature {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const conf = v.confidence as Record<string, unknown> | undefined;
  return (
    typeof v.question_id === "string" &&
    v.question_id.length > 0 &&
    typeof v.learning_objective === "string" &&
    Array.isArray(v.reasoning_pattern) &&
    typeof v.abstract_structure === "string" &&
    typeof v.format === "string" &&
    typeof v.context === "string" &&
    typeof v.cognitive_level === "string" &&
    typeof v.reasoning_direction === "string" &&
    typeof v.difficulty === "string" &&
    typeof v.difficulty_reference_frame === "string" &&
    typeof conf === "object" &&
    conf !== null &&
    typeof conf.overall === "number"
  );
}

// One call per SegmentedQuestion -- Stage 1 never re-segments (its own
// prompt says so explicitly), so this always operates on exactly one
// already-isolated gradable unit. Returns null (not a thrown error) on a
// malformed response after retries -- the caller (pipelineRunner) routes
// that one question straight to the review queue rather than failing the
// whole batch over it, same "fail open per unit of work" posture as
// stage0Segmenter's dropped-record handling.
export async function runAnalyzer(params: {
  question: SegmentedQuestion;
  curriculumTaxonomyText?: string;
}): Promise<{ signature: QuestionSignature; model: string; usage: { promptTokens: number; completionTokens: number } } | null> {
  const { question, curriculumTaxonomyText } = params;
  const taxonomySupplied = question.education_context.curriculum_source.taxonomy_supplied;

  try {
    const { data, model, usage } = await getJsonCompletion({
      systemPrompt: buildAnalyzerPrompt({ taxonomySupplied, curriculumTaxonomyText }),
      message: JSON.stringify(question),
      maxTokens: MAX_TOKENS,
    });

    if (!isValidQuestionSignature(data)) {
      console.warn(
        `Stage 1 produced an invalid QuestionSignature for ${question.question_id}:`,
        JSON.stringify(data).slice(0, 500)
      );
      return null;
    }

    // Same belt-and-suspenders stamp as Stage 0.
    const signature: QuestionSignature = { ...data, education_context: question.education_context };
    return { signature, model, usage };
  } catch (err) {
    console.warn(`Stage 1 failed for ${question.question_id}:`, err);
    return null;
  }
}
