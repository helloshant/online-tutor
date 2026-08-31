import { getJsonCompletion } from "./jsonCompletion.js";
import { buildSegmenterPrompt } from "./prompts.js";
import type { PdfAttachment } from "./llmTypes.js";
import type { LlmProvider } from "./llm.js";
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
//
// Exactly one of rawText/pdf is expected (pipelineRunner.ts enforces this
// at the call site, mirroring server.ts's own submission-time check) --
// when pdf is set, the paper's own text is never embedded in the JSON
// envelope below; the model reads it directly off the attached document
// (see anthropicProvider.ts).
export async function runSegmenter(params: {
  rawText?: string;
  pdf?: PdfAttachment;
  paper: PaperMeta;
  educationContext: EducationContext;
  provider?: LlmProvider;
}): Promise<SegmenterResult> {
  const { rawText, pdf, paper, educationContext, provider } = params;

  const message = JSON.stringify({
    education_context: educationContext,
    paper,
    ...(pdf ? { raw_text: "(see attached PDF document)" } : { raw_text: rawText }),
  });

  const { data, model, usage } = await getJsonCompletion({
    systemPrompt: buildSegmenterPrompt(),
    message,
    maxTokens: MAX_TOKENS,
    pdf,
    provider,
  });

  if (!Array.isArray(data)) {
    throw new Error("Segmenter response was not a JSON array");
  }

  // A genuinely empty array (as opposed to a non-empty array whose records
  // all failed isValidSegmentedQuestion below, which already logs one
  // warning per dropped record) produced NO log output at all before this
  // -- a paper that silently segments to zero questions is exactly the
  // "No questions were segmented -- nothing to analyze" run outcome, and
  // with nothing printed anywhere, there was no way to tell that apart
  // from every other possible cause of that same message after the fact.
  // Logging the paper's own identity plus the input actually sent (a
  // snippet of the raw text, or confirmation it was a PDF) turns this into
  // something diagnosable from `docker logs` alone on the next attempt.
  if (data.length === 0) {
    console.warn(
      `Stage 0 returned zero segmented questions for paper ${paper.board} ${paper.subject} ${paper.year}` +
        (paper.set_code ? ` (${paper.set_code})` : "") +
        (pdf
          ? " -- input was a PDF document."
          : ` -- input was ${rawText?.length ?? 0} character(s) of raw text, starting: ` +
            `${JSON.stringify((rawText ?? "").slice(0, 300))}`)
    );
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

  // archetype_segmented_questions.parent_question_id is a foreign key onto
  // this same table's own question_id -- despite the SEGMENTATION RULE's
  // own instruction to always emit a standalone record for a shared stem/
  // stimulus, a model occasionally sets parent_question_id to a value it
  // never actually produced a record for (e.g. it stored the stimulus text
  // inline on each sibling instead of as its own record). Left alone, that
  // single dangling reference would fail the ENTIRE batch insert for this
  // paper at once (one Postgres statement, one constraint violation) --
  // silently losing every other, otherwise-valid record in it. Null out
  // just the dangling references instead (the record becomes standalone,
  // its raw_text is unaffected) so this is a per-record data-quality note,
  // never a whole-paper failure.
  const questionIds = new Set(questions.map((q) => q.question_id));
  let orphanedParentCount = 0;
  for (const q of questions) {
    if (q.parent_question_id && !questionIds.has(q.parent_question_id)) {
      console.warn(
        `SegmentedQuestion ${q.question_id} references parent_question_id ${q.parent_question_id}, which isn't ` +
          "a question_id in this same batch -- clearing it rather than failing the whole paper's insert."
      );
      q.parent_question_id = null;
      orphanedParentCount++;
    }
  }
  if (orphanedParentCount > 0) {
    console.warn(`Cleared ${orphanedParentCount} dangling parent_question_id reference(s) from Stage 0 output.`);
  }

  return { questions, droppedCount, model, usage };
}
