import { getSupabaseClient } from "./supabaseClient.js";
import { runSegmenter } from "./stage0Segmenter.js";
import { runAnalyzer } from "./stage1Analyzer.js";
import { clusterSignatures } from "./clustering.js";
import { runMiner } from "./stage2Miner.js";
import { runCritic } from "./stage3Critic.js";
import { lookupStoredTaxonomy } from "./curriculumTaxonomy.js";
import { lowConfidenceThreshold, toInsertRow, type ReviewQueueCandidate } from "./reviewQueue.js";
import { getActiveLlmProvider, type LlmProvider } from "./llm.js";
import { LlmJsonParseError } from "./jsonCompletion.js";
import type {
  Archetype,
  ClusterInput,
  EducationContext,
  PipelineRunStats,
  PipelineStatus,
  PreSegmentedInput,
  QuestionSignature,
  RawPaperInput,
  SegmentedQuestion,
} from "./types.js";

// Runs entirely in-process, fire-and-forget from the API handler
// (server.ts) -- no queue/worker infra (matches every other service in
// this repo: no Redis job queue anywhere except the orchestrator's answer
// cache, which is a different thing entirely). A run's true state always
// lives in archetype_pipeline_runs, not in memory, specifically so a
// service restart mid-run is at least OBSERVABLE (status stays wherever it
// last got to, rather than vanishing) even though this first version can't
// resume a run that was interrupted -- restarting an interrupted run means
// resubmitting it.

export type SubmitRunParams = {
  educationContext: EducationContext;
  curriculumTaxonomyText?: string;
  createdBy?: string | null;
  // Explicit per-run choice (an admin with both providers' credentials
  // configured can pick whichever fits this submission -- Anthropic for a
  // PDF-based paper, Azure OpenAI otherwise). Falls back to the service's
  // own LLM_PROVIDER default when omitted -- resolved once in submitRun,
  // never re-read mid-run, so a run's provider stays fixed for its whole
  // lifetime even if the service-wide default changes while it's still
  // going (a run can take minutes to hours).
  llmProvider?: LlmProvider;
} & (
  | { inputKind: "raw_papers"; papers: RawPaperInput[] }
  | { inputKind: "pre_segmented"; questions: PreSegmentedInput[] }
);

async function updateRun(
  runId: string,
  patch: { status?: PipelineStatus; stats?: PipelineRunStats; error?: string | null; completed_at?: string | null }
) {
  const supabase = getSupabaseClient();
  await supabase
    .from("archetype_pipeline_runs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", runId);
}

async function mergeStats(runId: string, patch: Partial<PipelineRunStats>) {
  const supabase = getSupabaseClient();
  const { data } = await supabase.from("archetype_pipeline_runs").select("stats").eq("id", runId).single();
  const current = (data?.stats as PipelineRunStats | undefined) ?? {};
  await updateRun(runId, { stats: { ...current, ...patch } });
}

// Each runSegmenter() call is independent -- one paper, no visibility into
// any sibling paper submitted in the SAME run (a multi-file batch, see
// admin/archetype-miner/actions.ts) -- and papers in one batch commonly
// share IDENTICAL paper metadata by design (that action's own "every file
// shares the ONE set of paper-metadata fields" note), so the model has no
// way to know its own "Q1" needs to differ from another file's "Q1" when,
// from its own perspective, they look like the same paper. question_id is
// only a primary key WITHIN one run (see
// 0041_archetype_miner_run_scoped_ids.sql), so a collision here is a
// same-run, cross-paper collision, not a cross-run one -- rename the
// colliding record (and, since a rename must not silently break a
// parent_question_id link, every record in the SAME paper's own batch
// that pointed at the original id) with a paper-index suffix that's
// unique by construction (each paper index in one run is only ever used
// once), rather than letting the whole paper's insert fail the way an
// unresolved collision did before this existed.
function dedupeAcrossPapers(
  questions: SegmentedQuestion[],
  usedQuestionIds: Set<string>,
  paperIndex: number
): { deduped: SegmentedQuestion[]; renamedCount: number } {
  const idMap = new Map<string, string>();
  for (const q of questions) {
    if (usedQuestionIds.has(q.question_id)) {
      idMap.set(q.question_id, `${q.question_id}-paper${paperIndex}`);
    }
  }
  const deduped = questions.map((q) => ({
    ...q,
    question_id: idMap.get(q.question_id) ?? q.question_id,
    parent_question_id: q.parent_question_id ? (idMap.get(q.parent_question_id) ?? q.parent_question_id) : q.parent_question_id,
  }));
  return { deduped, renamedCount: idMap.size };
}

// A record referenced as another record's own parent_question_id is, by
// Stage 0's own SEGMENTATION RULE (see prompts.ts), the shared stem/
// stimulus holder for those children -- not itself an independently
// gradable reasoning unit. The prompt instructs the model to still emit a
// standalone record for it (so the shared text is stored somewhere), but
// sending that record through Stage 1 (Analyzer) anyway wastes a call that
// predictably comes back with nulls where a real signature needs real
// values (nothing to classify -- there's no independent reasoning task),
// which then either fails validation outright or clutters the review queue
// with an "insufficient information" result that isn't a genuine ambiguity
// needing a human decision. marks !== null is the one exception: a stem
// that WAS independently awarded marks (see the SEGMENTATION RULE's own
// DO NOT clause on this) is a real gradable unit in its own right despite
// also being a parent, so it still goes through Stage 1 normally.
function excludeStemOnlyParents(questions: SegmentedQuestion[]): {
  analyzable: SegmentedQuestion[];
  excludedCount: number;
} {
  const parentIds = new Set(
    questions.map((q) => q.parent_question_id).filter((id): id is string => Boolean(id))
  );
  const analyzable = questions.filter((q) => !(parentIds.has(q.question_id) && q.marks === null));
  return { analyzable, excludedCount: questions.length - analyzable.length };
}

async function queueForReview(runId: string, candidates: ReviewQueueCandidate[]): Promise<void> {
  if (candidates.length === 0) return;
  const supabase = getSupabaseClient();
  const rows = candidates.map((c) => toInsertRow(runId, c));
  const { error } = await supabase.from("archetype_review_queue").insert(rows);
  if (error) console.error(`Failed to insert ${rows.length} review-queue row(s) for run ${runId}:`, error);
}

// Creates the run row and kicks off execution WITHOUT awaiting it --
// server.ts's POST handler returns as soon as this resolves (i.e.
// immediately after the insert), not once the pipeline finishes. A run can
// legitimately take minutes to hours (one LLM call per question for Stage
// 1 alone), so this is never meant to be a synchronous request/response.
export async function submitRun(params: SubmitRunParams): Promise<string> {
  const supabase = getSupabaseClient();
  // Resolved once, here, not left as undefined for executeRun to resolve
  // later -- see SubmitRunParams.llmProvider's own comment on why this
  // needs to be fixed for the run's whole lifetime.
  const llmProvider = params.llmProvider ?? getActiveLlmProvider();

  const { data, error } = await supabase
    .from("archetype_pipeline_runs")
    .insert({
      education_context: params.educationContext,
      input_kind: params.inputKind,
      llm_provider: llmProvider,
      status: "pending",
      created_by: params.createdBy ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create pipeline run: ${error?.message ?? "unknown error"}`);
  }

  const runId = data.id as string;

  // Fire-and-forget: any error thrown inside executeRun is caught there and
  // written to the run row itself (status:'failed', error: message) -- it
  // must never become an unhandled promise rejection that crashes this
  // long-lived service over one bad run.
  void executeRun(runId, params, llmProvider).catch((err) => {
    console.error(`Unhandled error in pipeline run ${runId}:`, err);
  });

  return runId;
}

async function executeRun(runId: string, params: SubmitRunParams, llmProvider: LlmProvider): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    // Resolve once per run, not per question: an explicitly-supplied
    // curriculum_taxonomy_text on the submission always wins (lets a
    // one-off run override or supply a taxonomy that was never saved),
    // otherwise fall back to whatever's stored for this run's own
    // curriculum_source (see curriculumTaxonomy.ts) -- undefined either
    // way just means Stage 1 classifies at capped confidence, same as
    // before this existed.
    const curriculumTaxonomyText =
      params.curriculumTaxonomyText ?? (await lookupStoredTaxonomy(params.educationContext.curriculum_source));

    // Corrected, not the raw submitted value: taxonomy_supplied drives
    // which branch of Stage 1's own prompt runs (buildAnalyzerPrompt), so
    // it needs to reflect whether curriculumTaxonomyText actually resolved
    // to something -- a caller could submit taxonomy_supplied:false while
    // an admin had already saved a taxonomy for this curriculum_source (or
    // vice versa), and the PROMPT must agree with what it was actually
    // given, not what the submission merely claimed.
    const educationContext: EducationContext = {
      ...params.educationContext,
      curriculum_source: {
        ...params.educationContext.curriculum_source,
        taxonomy_supplied: Boolean(curriculumTaxonomyText),
      },
    };

    // ---------------------------------------------------------------
    // Stage 0 -- Segmenter (skipped entirely for pre_segmented input)
    // ---------------------------------------------------------------
    let segmentedCount = 0;
    let papersFailed = 0;

    if (params.inputKind === "raw_papers") {
      await updateRun(runId, { status: "segmenting" });
      const usedQuestionIds = new Set<string>();
      let paperIndex = 0;
      for (const paperInput of params.papers) {
        paperIndex++;
        const paperLabel = `${paperInput.paper.board} ${paperInput.paper.subject} ${paperInput.paper.year}`;

        // Own try/catch per paper -- this whole function's outer one
        // would otherwise let ONE paper's Segmenter failure (a parse
        // error from a truncated response, most commonly -- see
        // stage0Segmenter.ts's own MAX_TOKENS comment) abort the ENTIRE
        // run, losing every other paper in a multi-file batch that
        // segmented fine. Every other stage in this pipeline already
        // fails open per unit of work; Stage 0 needs the same posture at
        // the paper level now that one run can carry several papers.
        let result: Awaited<ReturnType<typeof runSegmenter>>;
        try {
          result = await runSegmenter({
            rawText: paperInput.raw_text,
            pdf: paperInput.pdf_base64 ? { mediaType: "application/pdf", base64: paperInput.pdf_base64 } : undefined,
            paper: paperInput.paper,
            educationContext,
            provider: llmProvider,
          });
        } catch (err) {
          papersFailed++;
          console.error(`Stage 0 (Segmenter) failed for paper ${paperIndex} (${paperLabel}) of run ${runId}:`, err);
          if (err instanceof LlmJsonParseError) {
            console.warn(
              `Paper ${paperIndex} (${paperLabel}) looks like it hit MAX_TOKENS -- the model's response was cut ` +
                "off before it could finish, either as invalid JSON (an unterminated string/array) or as a " +
                "syntactically complete but suspiciously short response (see jsonCompletion.ts's own " +
                "finishReason check). If this paper is unusually long, splitting it into smaller sections and " +
                "submitting them as separate files in one multi-file batch (see admin/archetype-miner/actions.ts) " +
                "usually resolves this."
            );
          }
          continue;
        }

        const { deduped, renamedCount } = dedupeAcrossPapers(result.questions, usedQuestionIds, paperIndex);
        if (renamedCount > 0) {
          console.warn(
            `Renamed ${renamedCount} question_id(s) in paper ${paperIndex} of run ${runId} to avoid colliding ` +
              "with an id already used by an earlier paper in this same batch submission."
          );
        }
        for (const q of deduped) usedQuestionIds.add(q.question_id);

        if (deduped.length > 0) {
          const { error } = await supabase.from("archetype_segmented_questions").insert(
            deduped.map((q) => ({
              question_id: q.question_id,
              run_id: runId,
              parent_question_id: q.parent_question_id,
              education_context: q.education_context,
              question: q,
            }))
          );
          if (error) console.error(`Failed to insert segmented questions for run ${runId}:`, error);
          else segmentedCount += deduped.length;
        }
      }
    } else {
      await updateRun(runId, { status: "segmenting" });
      const rows = params.questions.map((q) => ({
        question_id: q.question_id,
        run_id: runId,
        parent_question_id: q.parent_question_id,
        education_context: educationContext,
        question: { ...q, education_context: educationContext },
      }));
      if (rows.length > 0) {
        const { error } = await supabase.from("archetype_segmented_questions").insert(rows);
        if (error) console.error(`Failed to insert pre-segmented questions for run ${runId}:`, error);
        else segmentedCount = rows.length;
      }
    }

    await mergeStats(runId, { segmented: segmentedCount, papers_failed: papersFailed });

    if (segmentedCount === 0) {
      // Distinguishes "every paper's Segmenter call itself failed" (a real
      // failure, worth resubmitting after fixing whatever broke -- see the
      // per-paper catch block above) from "the model looked at real input
      // and legitimately found nothing to segment" (a genuine, if empty,
      // outcome -- e.g. a corrupted-text upload actions.ts's own DOCX
      // check now mostly catches before submission, but a run can still
      // reach here for content that check doesn't cover, like pasted text
      // or a PDF).
      await updateRun(runId, {
        status: papersFailed > 0 ? "failed" : "completed",
        completed_at: new Date().toISOString(),
        error:
          papersFailed > 0
            ? `${papersFailed} paper(s) failed to segment -- see the service logs for why. Nothing was produced.`
            : "No questions were segmented -- nothing to analyze.",
      });
      return;
    }

    // ---------------------------------------------------------------
    // Stage 1 -- Analyzer (one call per segmented question)
    // ---------------------------------------------------------------
    await updateRun(runId, { status: "analyzing" });

    const { data: segmentedRows } = await supabase
      .from("archetype_segmented_questions")
      .select("question")
      .eq("run_id", runId);

    const { analyzable: analyzableQuestions, excludedCount: stemsExcluded } = excludeStemOnlyParents(
      (segmentedRows ?? []).map((row) => row.question as SegmentedQuestion)
    );

    const signatures: QuestionSignature[] = [];
    const stage1ReviewCandidates: ReviewQueueCandidate[] = [];
    const threshold = lowConfidenceThreshold();

    for (const question of analyzableQuestions) {
      const result = await runAnalyzer({ question, curriculumTaxonomyText, provider: llmProvider });

      if (!result) {
        stage1ReviewCandidates.push({
          source: "stage1_low_confidence",
          reference_id: question.question_id,
          reason: "Stage 1 (Analyzer) failed to produce a usable signature after retries.",
          confidence: null,
        });
        continue;
      }

      signatures.push(result.signature);
      if (result.signature.confidence.overall < threshold) {
        stage1ReviewCandidates.push({
          source: "stage1_low_confidence",
          reference_id: result.signature.question_id,
          reason: `Overall confidence ${result.signature.confidence.overall} is below the ${threshold} threshold.`,
          confidence: result.signature.confidence.overall,
        });
      }
    }

    if (signatures.length > 0) {
      const { error } = await supabase.from("archetype_question_signatures").insert(
        signatures.map((s) => ({
          question_id: s.question_id,
          run_id: runId,
          education_context: s.education_context,
          signature: s,
          confidence_overall: s.confidence.overall,
        }))
      );
      if (error) console.error(`Failed to insert question signatures for run ${runId}:`, error);
    }
    await queueForReview(runId, stage1ReviewCandidates);
    await mergeStats(runId, { analyzed: signatures.length, stems_excluded: stemsExcluded });

    if (signatures.length === 0) {
      await updateRun(runId, {
        status: "completed",
        completed_at: new Date().toISOString(),
        error: "No signatures were produced -- nothing to cluster.",
      });
      return;
    }

    // ---------------------------------------------------------------
    // Embedding + clustering (algorithmic, not an LLM stage -- see
    // clustering.ts's own comment on why this is a "pipeline/infra
    // decision, not just a prompt instruction" per v2 §5)
    // ---------------------------------------------------------------
    await updateRun(runId, { status: "clustering" });

    const { clusters, embeddingsByQuestionId, unembeddedQuestionIds } = await clusterSignatures(signatures);

    if (embeddingsByQuestionId.size > 0) {
      const embeddingRows = Array.from(embeddingsByQuestionId.entries()).map(([questionId, vector]) => {
        const sig = signatures.find((s) => s.question_id === questionId) as QuestionSignature;
        return {
          question_id: questionId,
          run_id: runId,
          education_context: sig.education_context,
          embedding: vector,
        };
      });
      const { error } = await supabase.from("archetype_question_embeddings").insert(embeddingRows);
      if (error) console.error(`Failed to insert embeddings for run ${runId}:`, error);
    }

    if (clusters.length > 0) {
      const { error } = await supabase.from("archetype_clusters").insert(
        clusters.map((c) => ({
          cluster_id: c.cluster_id,
          run_id: runId,
          education_context: c.education_context,
          member_question_ids: c.member_signatures.map((s) => s.question_id),
          diagnostics: c.cluster_diagnostics,
        }))
      );
      if (error) console.error(`Failed to insert clusters for run ${runId}:`, error);
    }

    await queueForReview(
      runId,
      unembeddedQuestionIds.map((id) => ({
        source: "stage2_ambiguous_cluster",
        reference_id: id,
        reason: "Embedding failed for this question's scope -- it could not be clustered.",
        confidence: null,
      }))
    );
    await mergeStats(runId, { clusters: clusters.length });

    // ---------------------------------------------------------------
    // Stage 2 -- Miner (one call per cluster)
    // ---------------------------------------------------------------
    await updateRun(runId, { status: "mining" });

    const allCandidates: Archetype[] = [];
    const stage2ReviewCandidates: ReviewQueueCandidate[] = [];

    for (const cluster of clusters) {
      const result = await runMiner(cluster, llmProvider);
      if (!result) {
        stage2ReviewCandidates.push(
          ...cluster.member_signatures.map((s) => ({
            source: "stage2_ambiguous_cluster" as const,
            reference_id: s.question_id,
            reason: `Stage 2 (Miner) failed for cluster ${cluster.cluster_id} after retries.`,
            confidence: cluster.cluster_diagnostics.intra_cluster_cohesion,
          }))
        );
        continue;
      }
      allCandidates.push(...result.archetypes);
      stage2ReviewCandidates.push(
        ...result.unassignedQuestionIds.map((id) => ({
          source: "stage2_ambiguous_cluster" as const,
          reference_id: id,
          reason: `Stage 2 flagged this question as not belonging to any proposed archetype in cluster ${cluster.cluster_id}.`,
          confidence: cluster.cluster_diagnostics.intra_cluster_cohesion,
        }))
      );
    }

    if (allCandidates.length > 0) {
      const { error } = await supabase.from("archetypes").insert(
        allCandidates.map((a) => ({
          archetype_id: a.archetype_id,
          run_id: runId,
          education_context: a.education_context,
          archetype: a,
          status: a.status,
          critic_decision: a.critic_decision,
          mining_confidence: a.mining_confidence,
        }))
      );
      if (error) console.error(`Failed to insert candidate archetypes for run ${runId}:`, error);
    }
    await queueForReview(runId, stage2ReviewCandidates);
    await mergeStats(runId, { mined: allCandidates.length });

    // ---------------------------------------------------------------
    // Stage 3 -- Critic (one call over the whole run's candidate
    // catalogue -- every candidate in this run shares one
    // education_context by construction, see the run's own
    // education_context field, so there is only ever one scope to
    // critique here)
    // ---------------------------------------------------------------
    await updateRun(runId, { status: "critiquing" });

    const criticResult = allCandidates.length > 0 ? await runCritic(allCandidates, llmProvider) : { reviewed: [] };
    const reviewed = criticResult?.reviewed ?? [];

    const stage3ReviewCandidates: ReviewQueueCandidate[] = reviewed
      .filter((a) => a.critic_decision === "REVIEW")
      .map((a) => ({
        source: "stage3_review_flag" as const,
        reference_id: a.archetype_id,
        reason: a.critic_rationale ?? "Flagged REVIEW by Stage 3 with no rationale text.",
        confidence: a.mining_confidence,
      }));

    for (const archetype of reviewed) {
      const isNew = archetype.critic_decision === "ADD" && !allCandidates.some((c) => c.archetype_id === archetype.archetype_id);
      if (isNew) {
        const { error } = await supabase.from("archetypes").insert({
          archetype_id: archetype.archetype_id,
          run_id: runId,
          education_context: archetype.education_context,
          archetype,
          status: archetype.status,
          critic_decision: archetype.critic_decision,
          mining_confidence: archetype.mining_confidence,
        });
        if (error) console.error(`Failed to insert ADDed archetype ${archetype.archetype_id}:`, error);
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
          // archetype_id alone is no longer globally unique (see
          // 0041_archetype_miner_run_scoped_ids.sql) -- without also
          // scoping by run_id, this could update another run's own row
          // that happens to share the same archetype_id.
          .eq("run_id", runId)
          .eq("archetype_id", archetype.archetype_id);
        if (error) console.error(`Failed to update reviewed archetype ${archetype.archetype_id}:`, error);
      }
    }
    await queueForReview(runId, stage3ReviewCandidates);
    await mergeStats(runId, { reviewed: reviewed.length });

    const { count: reviewQueueCount } = await supabase
      .from("archetype_review_queue")
      .select("*", { count: "exact", head: true })
      .eq("run_id", runId)
      .eq("status", "pending");
    await mergeStats(runId, { review_queue: reviewQueueCount ?? 0 });

    await updateRun(runId, { status: "completed", completed_at: new Date().toISOString(), error: null });
  } catch (err) {
    console.error(`Pipeline run ${runId} failed:`, err);
    await updateRun(runId, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      completed_at: new Date().toISOString(),
    });
  }
}
