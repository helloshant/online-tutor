import { getJsonCompletion } from "./jsonCompletion.js";
import { buildSegmenterPrompt } from "./prompts.js";
import type { EducationContext, PaperMeta, SegmentedQuestion } from "./types.js";

const MAX_TOKENS = 8000;

// Loose but real validation -- not full schema validation, just enough to
// guarantee every downstream stage can trust the shape it reads (Stage 1
// takes ONE SegmentedQuestion as-is, with no re-segmentation step of its
// own, so a malformed record here would otherwise surface as a confusing
// Stage 1 failure far from its actual cause). A record that fails this
// check is dropped and logged, not force-coerced -- fail open PER
// question, never crash the whole paper's segmentation over one bad
// record, matching how the rest of this pipeline treats per-unit failures.
function isValidSegmentedQuestion(value: unknown): value is SegmentedQuestion {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.question_id === "string" &&
    v.question_id.length > 0 &&
    typeof v.raw_text === "string" &&
    typeof v.cleaned_text === "string" &&
    typeof v.has_diagram === "boolean" &&
    typeof v.has_internal_choice === "boolean" &&
    typeof v.extraction_confidence === "number" &&
    typeof v.paper === "object" &&
    v.paper !== null
  );
}

export type SegmenterResult = {
  questions: SegmentedQuestion[];
  droppedCount: number;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
};

// One call per raw paper (or paper section) -- the source doc's own Stage
// 0 scope ("given the raw extracted text of one examination paper").
// education_context is fixed for the whole batch this paper belongs to and
// stamped onto every record here (not left to the model to infer or
// possibly drift across records within one paper).
export async function runSegmenter(params: {
  rawText: string;
  paper: PaperMeta;
  educationContext: EducationContext;
}): Promise<SegmenterResult> {
  const { rawText, paper, educationContext } = params;

  const message = JSON.stringify({
    education_context: educationContext,
    paper,
    raw_text: rawText,
  });

  const { data, model, usage } = await getJsonCompletion({
    systemPrompt: buildSegmenterPrompt(),
    message,
    maxTokens: MAX_TOKENS,
  });

  if (!Array.isArray(data)) {
    throw new Error("Segmenter response was not a JSON array");
  }

  const questions: SegmentedQuestion[] = [];
  let droppedCount = 0;
  for (const raw of data) {
    if (isValidSegmentedQuestion(raw)) {
      // Belt-and-suspenders: the model is instructed to copy
      // education_context unchanged, but this stamps it authoritatively
      // rather than trusting that instruction was followed -- the caller
      // (pipelineRunner) supplied one fixed value for the whole run, so
      // there is never a legitimate reason for a record to disagree.
      questions.push({ ...raw, education_context: educationContext });
    } else {
      droppedCount++;
      console.warn("Dropped an invalid SegmentedQuestion from Stage 0 output:", JSON.stringify(raw).slice(0, 500));
    }
  }

  return { questions, droppedCount, model, usage };
}
