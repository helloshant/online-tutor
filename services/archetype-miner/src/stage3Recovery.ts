import { getSupabaseClient } from "./supabaseClient.js";
import { runCritic } from "./stage3Critic.js";
import type { LlmProvider } from "./llm.js";
import type { Archetype } from "./types.js";

// One-time backfill for a real, now-fixed Stage 3 bug: the OLD Critic
// prompt asked the model to retype nearly the entire Archetype object
// (including a stats block the code never even read back) for every
// candidate in a batch, even an ordinary untouched KEEP -- a repetitive
// transcription task the model would routinely give up on partway
// through, silently leaving most of a batch's candidates undecided. That
// wasn't a parse failure or a caught exception (nothing for the ordinary
// per-batch error handling to catch) -- normalizeReviewed's own "no valid
// decision -> REVIEW" fallback caught it structurally instead, which
// correctly prevented anything from silently passing through as an
// unreviewed KEEP, but also means every one of those candidates has sat
// in archetype_review_queue as a synthesized REVIEW ever since, with the
// exact same generic rationale, never actually looked at by the model at
// all. Confirmed directly against production data: ~5,400 archetypes
// across ~190 runs, this exact rationale text, dwarfing every other
// review-queue reason combined.
//
// The Critic prompt (see buildCriticPrompt) and stage3Critic.ts's own
// batch-retry now fix this going forward. This module re-runs Stage 3,
// under the FIXED prompt, on just the archetypes stuck by the old bug --
// never on a genuine Stage 3 REVIEW (real ambiguity a human should still
// decide), which this deliberately leaves untouched.
const FALLBACK_RATIONALE_EXACT = "Stage 3's response for this batch did not include a decision for this archetype.";
const FALLBACK_RATIONALE_PREFIX = "Stage 3 failed to review this batch:";
// The retried, still-incomplete-after-retry variant stage3Critic.ts's own
// missing-candidate retry can now also produce -- same bug family, same
// eligibility for recovery.
const FALLBACK_RATIONALE_RETRY_EXACT =
  "Stage 3's response for this batch did not include a decision for this archetype, even after retrying just the missing one(s).";

function isFallbackRationale(rationale: string | null | undefined): boolean {
  if (!rationale) return false;
  return (
    rationale === FALLBACK_RATIONALE_EXACT ||
    rationale === FALLBACK_RATIONALE_RETRY_EXACT ||
    rationale.startsWith(FALLBACK_RATIONALE_PREFIX)
  );
}

type StoredArchetypeRow = { run_id: string; archetype_id: string; archetype: Archetype };

async function loadFallbackRows(): Promise<StoredArchetypeRow[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("archetypes")
    .select("run_id, archetype_id, archetype")
    .eq("critic_decision", "REVIEW");
  if (error) {
    console.error("Stage 3 recovery: failed to load REVIEW archetypes:", error);
    return [];
  }
  return ((data ?? []) as StoredArchetypeRow[]).filter((row) => isFallbackRationale(row.archetype.critic_rationale));
}

export type Stage3RecoveryPreview = { affectedRuns: number; affectedArchetypes: number };

// Counts only -- no LLM calls, no writes. Lets an admin see the real
// scope (and therefore roughly the cost/time) before committing to the
// run below.
export async function previewStage3Recovery(): Promise<Stage3RecoveryPreview> {
  const rows = await loadFallbackRows();
  return { affectedRuns: new Set(rows.map((r) => r.run_id)).size, affectedArchetypes: rows.length };
}

// Strips an Archetype back to plain Stage-2-shaped output before handing
// it to runCritic -- these rows currently carry the STALE critic_* fields
// the fallback wrote (critic_decision:"REVIEW", the generic rationale,
// status:"reviewed"), which must not leak into the model's input: Stage
// 3's own prompt describes its INPUT as "status: candidate" catalogue
// entries with no critic_* fields at all, and feeding it something that
// already looks reviewed would be a confusing, ungrounded thing to ask it
// to re-decide on.
function asCandidate(archetype: Archetype): Archetype {
  return {
    ...archetype,
    status: "candidate",
    critic_decision: null,
    critic_rationale: null,
    critic_evidence: [],
    merge_target_id: null,
    split_result_ids: [],
  };
}

export type Stage3RecoveryResult = {
  runsProcessed: number;
  archetypesProcessed: number;
  resolvedToDecision: number;
  stillReview: number;
  runsFailed: number;
};

// The actual recovery -- one runCritic call per affected run (never
// mixing runs into one batch: each run has its own education_context and
// its own llm_provider, and keeping the grouping matches how Stage 3 was
// originally scoped in pipelineRunner.ts's own executeRun). Long-running
// (this is exactly the same shape of work as a real pipeline run's own
// Stage 3 pass, just replayed for a backlog instead of a fresh mining
// run) -- callers should fire this in the background, not await it
// inline in a request handler (see server.ts's own POST route).
export async function runStage3Recovery(): Promise<Stage3RecoveryResult> {
  const supabase = getSupabaseClient();
  const rows = await loadFallbackRows();

  const result: Stage3RecoveryResult = {
    runsProcessed: 0,
    archetypesProcessed: 0,
    resolvedToDecision: 0,
    stillReview: 0,
    runsFailed: 0,
  };

  const byRun = new Map<string, StoredArchetypeRow[]>();
  for (const row of rows) {
    const group = byRun.get(row.run_id);
    if (group) group.push(row);
    else byRun.set(row.run_id, [row]);
  }

  console.log(`Stage 3 recovery: starting on ${rows.length} archetype(s) across ${byRun.size} run(s).`);

  for (const [runId, runRows] of byRun) {
    try {
      const [{ data: runRow }, { data: existingRows }] = await Promise.all([
        supabase.from("archetype_pipeline_runs").select("llm_provider").eq("id", runId).maybeSingle(),
        // The run's FULL existing archetype_id set, not just the fallback
        // subset being recovered (runRows below) -- confirmed directly in
        // production: an ADD this recovery pass proposed (working from
        // only the fallback subset, with less cross-candidate context
        // than the original run had) generated the exact same slug-style
        // id as an archetype ELSEWHERE in the same run that was never
        // part of this recovery at all (already properly reviewed the
        // first time around). Checking isNew against runRows alone
        // wrongly called that "new" and tried to INSERT it, colliding
        // with the real row on the (run_id, archetype_id) primary key.
        supabase.from("archetypes").select("archetype_id").eq("run_id", runId),
      ]);
      // Re-review under the SAME provider the original run used --
      // matches SubmitRunParams.llmProvider's own "fixed for a run's
      // whole lifetime" reasoning; an undefined value just falls back to
      // the service's own current default, same as any other call site.
      const llmProvider = (runRow?.llm_provider as LlmProvider | undefined) ?? undefined;

      const candidates = runRows.map((r) => asCandidate(r.archetype));
      const { reviewed } = await runCritic(candidates, llmProvider);

      const knownIds = new Set(runRows.map((r) => r.archetype_id));
      const existingIds = new Set(((existingRows ?? []) as { archetype_id: string }[]).map((r) => r.archetype_id));
      for (const archetype of reviewed) {
        result.archetypesProcessed++;

        if (existingIds.has(archetype.archetype_id) && !knownIds.has(archetype.archetype_id)) {
          // A same-id collision with an archetype that was NEVER part of
          // this recovery -- almost certainly Stage 3 re-proposing (under
          // reduced context) something that already exists properly
          // reviewed elsewhere in this run. Never insert (constraint
          // violation, as seen in production) and never update (that
          // archetype's real, already-reviewed content would be
          // overwritten by a pass that never actually looked at it) --
          // just skip, leaving the pre-existing archetype exactly as it
          // was. Nothing to resolve on the review queue either: a
          // collided id never had its own pending entry.
          console.warn(
            `Stage 3 recovery: run ${runId} proposed archetype_id "${archetype.archetype_id}" which already exists ` +
              "in this run outside the recovered subset -- skipping rather than inserting (constraint violation) " +
              "or overwriting the existing, already-reviewed archetype."
          );
          continue;
        }

        const isNew = !existingIds.has(archetype.archetype_id);
        if (isNew) {
          // A genuine ADD this recovery pass itself noticed -- rare
          // (this call only ever sees the fallback subset, not the full
          // original catalogue, so it has less cross-candidate context
          // than the original run did), but handled the same way
          // pipelineRunner.ts's own Stage 3 section already does. The
          // prompt tells the model not to include education_context on an
          // ADD (the caller stamps it on) -- every candidate in this
          // group shares one run_id, so any of them is a safe source for
          // that stamp.
          const educationContext = archetype.education_context ?? runRows[0].archetype.education_context;
          const { error } = await supabase.from("archetypes").insert({
            archetype_id: archetype.archetype_id,
            run_id: runId,
            education_context: educationContext,
            archetype: { ...archetype, education_context: educationContext },
            status: archetype.status,
            critic_decision: archetype.critic_decision,
            mining_confidence: archetype.mining_confidence,
          });
          if (error) console.error(`Stage 3 recovery: failed to insert ADDed archetype ${archetype.archetype_id}:`, error);
        } else {
          const { error } = await supabase
            .from("archetypes")
            .update({
              archetype,
              status: archetype.status,
              critic_decision: archetype.critic_decision,
              mining_confidence: archetype.mining_confidence,
              updated_at: new Date().toISOString(),
            })
            .eq("run_id", runId)
            .eq("archetype_id", archetype.archetype_id);
          if (error) console.error(`Stage 3 recovery: failed to update archetype ${archetype.archetype_id}:`, error);
        }

        if (archetype.critic_decision === "REVIEW") {
          result.stillReview++;
          // A genuine REVIEW this time (or, in the rare worst case, the
          // same bug reproducing on retry) -- either way the rationale is
          // now real/fresh, so update the existing queue row's reason
          // rather than resolving it; it's still genuinely pending.
          const { error } = await supabase
            .from("archetype_review_queue")
            .update({ reason: archetype.critic_rationale ?? "Flagged REVIEW by Stage 3 with no rationale text." })
            .eq("run_id", runId)
            .eq("source", "stage3_review_flag")
            .eq("reference_id", archetype.archetype_id)
            .eq("status", "pending");
          if (error) console.error(`Stage 3 recovery: failed to update review-queue reason for ${archetype.archetype_id}:`, error);
        } else {
          result.resolvedToDecision++;
          const { error } = await supabase
            .from("archetype_review_queue")
            .update({
              status: "resolved",
              resolution: `Automated Stage 3 recovery pass: ${archetype.critic_decision} -- ${archetype.critic_rationale ?? "no rationale given"}`,
              resolved_by: null,
              resolved_at: new Date().toISOString(),
            })
            .eq("run_id", runId)
            .eq("source", "stage3_review_flag")
            .eq("reference_id", archetype.archetype_id)
            .eq("status", "pending");
          if (error) console.error(`Stage 3 recovery: failed to resolve review-queue item for ${archetype.archetype_id}:`, error);
        }
      }

      // Refresh this run's own stats.review_queue -- mirrors the exact
      // recompute pipelineRunner.ts's own executeRun does after Stage 3,
      // so the run list's "Review queue: N" figure reflects the recovery
      // immediately rather than only after that run is next touched.
      const { count: reviewQueueCount } = await supabase
        .from("archetype_review_queue")
        .select("*", { count: "exact", head: true })
        .eq("run_id", runId)
        .eq("status", "pending");
      const { data: currentRun } = await supabase.from("archetype_pipeline_runs").select("stats").eq("id", runId).single();
      const currentStats = (currentRun?.stats as Record<string, unknown> | undefined) ?? {};
      await supabase
        .from("archetype_pipeline_runs")
        .update({ stats: { ...currentStats, review_queue: reviewQueueCount ?? 0 }, updated_at: new Date().toISOString() })
        .eq("id", runId);

      result.runsProcessed++;
    } catch (err) {
      result.runsFailed++;
      console.error(`Stage 3 recovery: run ${runId} failed (its ${runRows.length} archetype(s) remain REVIEW, unchanged):`, err);
    }
  }

  console.log(
    `Stage 3 recovery: done. ${result.runsProcessed} run(s) processed (${result.runsFailed} failed), ` +
      `${result.archetypesProcessed} archetype(s) re-reviewed -- ${result.resolvedToDecision} resolved to a real ` +
      `decision, ${result.stillReview} still REVIEW (now with a real rationale).`
  );

  return result;
}
