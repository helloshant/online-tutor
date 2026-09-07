import { getSupabaseClient } from "./supabaseClient.js";
import { getJsonCompletion } from "./jsonCompletion.js";
import { buildStudentExplanationBackfillPrompt } from "./prompts.js";
import { coerceStudentExplanation } from "./textCoercion.js";
import { getActiveLlmProvider, type LlmProvider } from "./llm.js";
import type { Archetype } from "./types.js";

// One-time backfill for student_explanation (added after archetypes were
// already mined -- see types.ts's own comment on that field) across the
// existing catalogue. Deliberately its own dedicated, minimal-output call
// per batch (see buildStudentExplanationBackfillPrompt's own comment) --
// the explicit design goal (per the human decision that led to this file
// existing at all) was minimizing ongoing LLM spend: generate this ONCE
// per archetype, at backfill/mining time, never per student click. Only
// runs against ACCEPTED archetypes (status reviewed/final, critic_decision
// KEEP/REVISE/ADD) -- the only ones any student-facing surface ever shows,
// so there's no reason to spend a single token explaining a MERGE/REMOVE/
// REVIEW archetype nobody will ever see.
const BATCH_SIZE = 30;
// Output per item is intentionally tiny (2-4 sentences, nothing else) --
// see the prompt's own SCHEMA -- so this has generous headroom even for a
// full 30-item batch, unlike Stage 3's old per-item-retyping problem.
const MAX_TOKENS = 4000;
// Same reasoning as stage3Recovery.ts's own FALLBACK_ROWS_PAGE_SIZE --
// page explicitly rather than trusting an unbounded select() to return
// everything in one call.
const PAGE_SIZE = 1000;

type PendingRow = { run_id: string; archetype_id: string; archetype: Archetype };

async function loadPendingRows(): Promise<PendingRow[]> {
  const supabase = getSupabaseClient();
  const rows: PendingRow[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("archetypes")
      .select("run_id, archetype_id, archetype")
      .in("status", ["reviewed", "final"])
      .in("critic_decision", ["KEEP", "REVISE", "ADD"])
      // Matches both an archetype mined before this field existed at all
      // (the key is simply absent from the stored jsonb) and one that
      // exists with an explicit JSON null (Stage 2/3 couldn't produce a
      // usable value) -- ->> extracts as text, and both an absent key and
      // a JSON null extract to SQL NULL through it, so `is null` catches
      // either case in one filter.
      .is("archetype->>student_explanation", null)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      console.error("student_explanation backfill: failed to load pending archetypes:", error);
      break;
    }
    const page = (data ?? []) as PendingRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

export type StudentExplanationBackfillPreview = { pendingArchetypes: number };

export async function previewStudentExplanationBackfill(): Promise<StudentExplanationBackfillPreview> {
  const rows = await loadPendingRows();
  return { pendingArchetypes: rows.length };
}

// Same single-process in-memory guard as stage3Recovery.ts's own
// recoveryInProgress, for the same reason -- see that file's own comment.
let backfillInProgress = false;

export function isStudentExplanationBackfillInProgress(): boolean {
  return backfillInProgress;
}

// One getJsonCompletion call per batch, asking ONLY for {archetype_id,
// student_explanation} pairs -- see the prompt's own SCHEMA. Retries once,
// with just the still-missing subset, on the same reasoning stage3Critic.ts's
// own missing-decision retry uses -- cheap insurance even though a tiny,
// fixed-shape per-item output should rarely trigger the "model gives up
// partway through a long repetitive transcription" failure this repo has
// already diagnosed twice this way (Stage 0, Stage 3).
async function requestExplanations(
  batch: PendingRow[],
  provider: LlmProvider,
  retriesLeft = 1
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  try {
    const { data } = await getJsonCompletion({
      systemPrompt: buildStudentExplanationBackfillPrompt(),
      message: JSON.stringify(
        batch.map((r) => ({
          archetype_id: r.archetype_id,
          name: r.archetype.name,
          concept: r.archetype.concept,
          learning_objective: r.archetype.learning_objective,
          invariant_reasoning_structure: r.archetype.invariant_reasoning_structure,
          education_context: r.archetype.education_context,
        }))
      ),
      maxTokens: MAX_TOKENS,
      provider,
    });

    if (!Array.isArray(data)) {
      console.warn(`student_explanation backfill: response was not a JSON array for a batch of ${batch.length}.`);
      return result;
    }

    for (const rawItem of data) {
      const raw = coerceStudentExplanation(rawItem);
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.archetype_id === "string" && typeof r.student_explanation === "string" && r.student_explanation.trim()) {
        result.set(r.archetype_id, r.student_explanation.trim());
      }
    }
  } catch (err) {
    console.warn(`student_explanation backfill: batch of ${batch.length} failed:`, err);
    return result;
  }

  const missing = batch.filter((r) => !result.has(r.archetype_id));
  if (missing.length > 0 && retriesLeft > 0) {
    const retried = await requestExplanations(missing, provider, retriesLeft - 1);
    for (const [id, text] of retried) result.set(id, text);
  }
  return result;
}

export type StudentExplanationBackfillResult = {
  batchesProcessed: number;
  archetypesProcessed: number;
  succeeded: number;
  stillMissing: number;
};

// Long-running, same posture as stage3Recovery.ts's own runStage3Recovery
// -- callers should fire this in the background, not await it inline in a
// request handler (see server.ts's own POST route).
export async function runStudentExplanationBackfill(): Promise<StudentExplanationBackfillResult> {
  if (backfillInProgress) {
    throw new Error("A student_explanation backfill is already running -- wait for it to finish before starting another.");
  }
  backfillInProgress = true;
  try {
    return await runStudentExplanationBackfillInner();
  } finally {
    backfillInProgress = false;
  }
}

async function runStudentExplanationBackfillInner(): Promise<StudentExplanationBackfillResult> {
  const supabase = getSupabaseClient();
  const rows = await loadPendingRows();

  const result: StudentExplanationBackfillResult = {
    batchesProcessed: 0,
    archetypesProcessed: 0,
    succeeded: 0,
    stillMissing: 0,
  };

  console.log(`student_explanation backfill: starting on ${rows.length} archetype(s).`);

  // One provider for the whole backfill (the service's own current
  // default) -- unlike Stage 3 recovery, there's no reason to match each
  // archetype's own originating run's provider: this explanation's
  // quality doesn't depend on which provider mined the archetype, only on
  // the fields already stored on it.
  const provider = getActiveLlmProvider();

  const batches: PendingRow[][] = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) batches.push(rows.slice(i, i + BATCH_SIZE));

  for (const batch of batches) {
    result.batchesProcessed++;
    const explanationById = await requestExplanations(batch, provider);

    for (const row of batch) {
      result.archetypesProcessed++;
      const explanation = explanationById.get(row.archetype_id) ?? null;
      const { error } = await supabase
        .from("archetypes")
        .update({ archetype: { ...row.archetype, student_explanation: explanation }, updated_at: new Date().toISOString() })
        .eq("run_id", row.run_id)
        .eq("archetype_id", row.archetype_id);
      if (error) {
        console.error(`student_explanation backfill: failed to save archetype ${row.archetype_id}:`, error);
      } else if (explanation) {
        result.succeeded++;
      } else {
        // Left as null (still missing) -- loadPendingRows's own filter
        // picks these back up on the NEXT run of this backfill, same
        // "fail open, retry the reactive way" posture as everywhere else
        // in this pipeline.
        result.stillMissing++;
      }
    }
  }

  console.log(
    `student_explanation backfill: done. ${result.batchesProcessed} batch(es), ${result.archetypesProcessed} ` +
      `archetype(s) processed -- ${result.succeeded} succeeded, ${result.stillMissing} still missing (will be ` +
      "retried on the next run of this backfill)."
  );

  return result;
}
