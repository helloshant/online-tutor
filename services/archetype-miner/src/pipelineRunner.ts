import { getSupabaseClient } from "./supabaseClient.js";
import { runSegmenter, type SegmenterResult } from "./stage0Segmenter.js";
import { runAnalyzer } from "./stage1Analyzer.js";
import { clusterSignatures } from "./clustering.js";
import { runMiner } from "./stage2Miner.js";
import { runCritic } from "./stage3Critic.js";
import { lookupStoredTaxonomy } from "./curriculumTaxonomy.js";
import { lowConfidenceThreshold, toInsertRow, type ReviewQueueCandidate } from "./reviewQueue.js";
import { getActiveLlmProvider, type LlmProvider } from "./llm.js";
import { LlmJsonParseError } from "./jsonCompletion.js";
import { COMPLETENESS_THRESHOLD, extractDeclaredQuestionCount, splitPaperText } from "./paperSplitter.js";
import type { PdfAttachment } from "./llmTypes.js";
import type {
  Archetype,
  ClusterInput,
  EducationContext,
  PaperMeta,
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

const MAX_SPLIT_DEPTH = 2;

function topLevelCount(questions: SegmentedQuestion[]): number {
  return questions.filter((q) => !q.parent_question_id).length;
}

// A CLEAN, non-throwing result can still be wrong -- confirmed directly
// against a real 33-question paper that came back with a complete,
// non-empty response covering only 5 questions, finish_reason NOT
// "length"/"max_tokens" (nothing for jsonCompletion.ts's own check to
// catch). The model had simply decided, on its own, that it was done.
// extractDeclaredQuestionCount's own comment covers why this heuristic
// exists and its limits; only fires on the kind of dramatic shortfall
// actually observed, never on ordinary per-question data-quality loss.
function looksIncomplete(rawText: string | undefined, questions: SegmentedQuestion[]): boolean {
  if (!rawText) return false;
  const declared = extractDeclaredQuestionCount(rawText);
  if (declared == null) return false;
  return topLevelCount(questions) < declared * COMPLETENESS_THRESHOLD;
}

// Wraps runSegmenter with a reactive auto-split retry, triggered by EITHER
// of two independent signals that a response can't be trusted as a
// genuine complete answer: a truncation failure (LlmJsonParseError -- see
// jsonCompletion.ts's finishReason check, which catches a syntactically-
// valid-but-silently-incomplete response, not just an invalid-JSON one),
// or a clean success that still looks incomplete against the paper's own
// stated question count (see looksIncomplete above). Either way, splits
// the raw text at the safest available boundary (see paperSplitter.ts)
// and retries Stage 0 on each piece separately, merging whatever
// succeeds. Only applies to raw_text papers -- a PDF attachment is read
// directly by the model page-by-page (see anthropicProvider.ts) and can't
// be text-split this way, so a PDF paper's truncation failure surfaces
// immediately, same as before this existed (and never looks "incomplete"
// by the second signal either, since that needs raw text to check against).
//
// Depth-limited (paper -> sections -> questions, no further) rather than
// splitting forever: a chunk that still won't fit/still looks incomplete
// after being split down to individual top-level questions is a
// genuinely oversized single question, or text with no recognizable
// boundary at all -- neither of which more splitting can fix. At every
// point where splitting isn't possible, this returns whatever partial
// result IS available rather than discarding it outright (only a genuine
// exception with no usable result at all propagates as a failure) --
// fail open, same posture as everywhere else in this pipeline.
async function runSegmenterWithAutoSplit(
  baseParams: { paper: PaperMeta; educationContext: EducationContext; provider?: LlmProvider },
  rawText: string | undefined,
  pdf: PdfAttachment | undefined,
  paperLabel: string,
  depth = 0
): Promise<SegmenterResult> {
  let result: SegmenterResult | undefined;
  let caughtErr: unknown;
  try {
    result = await runSegmenter({ ...baseParams, rawText, pdf });
  } catch (err) {
    caughtErr = err;
  }

  const incomplete = result ? looksIncomplete(rawText, result.questions) : false;
  if (result && !incomplete) {
    return result;
  }
  // A non-truncation failure (auth error, network, an actually-malformed
  // response after retries) is never something splitting can fix --
  // propagate it immediately rather than attempting to split.
  if (caughtErr && !(caughtErr instanceof LlmJsonParseError)) {
    throw caughtErr;
  }

  const canSplit = !pdf && Boolean(rawText) && depth < MAX_SPLIT_DEPTH;
  const { chunks, strategy } = canSplit ? splitPaperText(rawText as string) : { chunks: [], strategy: "none" as const };
  if (!canSplit || chunks.length < 2) {
    if (caughtErr) throw caughtErr;
    // incomplete === true is the only way to reach here with no
    // caughtErr, which requires `result` to be set (see looksIncomplete).
    console.warn(
      `${paperLabel} looks incomplete (far fewer questions than the paper's own stated count) but no further ` +
        "splitting is possible here (no recognizable boundary, or the depth limit was reached) -- returning the " +
        `${topLevelCount((result as SegmenterResult).questions)} question(s) segmented so far rather than ` +
        "discarding them."
    );
    return result as SegmenterResult;
  }

  console.warn(
    caughtErr
      ? `${paperLabel} hit MAX_TOKENS -- auto-splitting into ${chunks.length} chunk(s) by ${strategy} boundaries ` +
          `(depth ${depth + 1}/${MAX_SPLIT_DEPTH}) and retrying each separately.`
      : `${paperLabel} looks incomplete (far fewer questions than the paper's own stated count, with no ` +
          `truncation signal) -- auto-splitting into ${chunks.length} chunk(s) by ${strategy} boundaries ` +
          `(depth ${depth + 1}/${MAX_SPLIT_DEPTH}) and retrying each separately.`
  );

  const merged: SegmenterResult = {
    questions: [],
    droppedCount: 0,
    model: "",
    usage: { promptTokens: 0, completionTokens: 0 },
  };
  let anySucceeded = false;

  for (let i = 0; i < chunks.length; i++) {
    try {
      const chunkResult = await runSegmenterWithAutoSplit(
        baseParams,
        chunks[i],
        undefined,
        `${paperLabel} [chunk ${i + 1}/${chunks.length}]`,
        depth + 1
      );
      merged.questions.push(...chunkResult.questions);
      merged.droppedCount += chunkResult.droppedCount;
      merged.model = chunkResult.model || merged.model;
      merged.usage.promptTokens += chunkResult.usage.promptTokens;
      merged.usage.completionTokens += chunkResult.usage.completionTokens;
      anySucceeded = true;
    } catch (chunkErr) {
      // Fail open per chunk, same posture as everywhere else in this
      // pipeline -- one chunk still being too large (or itself hitting
      // the depth limit) shouldn't lose every other chunk that DID
      // segment successfully.
      console.error(`${paperLabel} [chunk ${i + 1}/${chunks.length}] failed even after auto-splitting:`, chunkErr);
    }
  }

  if (!anySucceeded) {
    if (caughtErr) throw caughtErr;
    console.warn(
      `${paperLabel} looks incomplete and every auto-split chunk failed -- returning the ` +
        `${topLevelCount((result as SegmenterResult).questions)} question(s) segmented before splitting was ` +
        "attempted, rather than discarding them."
    );
    return result as SegmenterResult;
  }
  return merged;
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
  // Checked against a running `seen` set (seeded from every earlier
  // paper's ids), not just usedQuestionIds directly, so a collision
  // WITHIN this same list -- e.g. two auto-split chunks of the same
  // paper (see paperSplitter.ts/runSegmenterWithAutoSplit) independently
  // producing the same question_id, since neither chunk's Stage 0 call
  // has any visibility into the other's output -- gets caught too, not
  // just a collision against a different paper. Two full passes: first
  // decide every rename, then apply them all together, so a child's
  // parent_question_id resolves correctly regardless of whether its
  // parent happens to come before or after it in the array.
  const seen = new Set(usedQuestionIds);
  let dupCounter = 0;
  for (const q of questions) {
    if (seen.has(q.question_id)) {
      let candidate = `${q.question_id}-paper${paperIndex}`;
      while (seen.has(candidate)) {
        dupCounter++;
        candidate = `${q.question_id}-paper${paperIndex}-dup${dupCounter}`;
      }
      idMap.set(q.question_id, candidate);
      seen.add(candidate);
    } else {
      seen.add(q.question_id);
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
          result = await runSegmenterWithAutoSplit(
            { paper: paperInput.paper, educationContext, provider: llmProvider },
            paperInput.raw_text,
            paperInput.pdf_base64 ? { mediaType: "application/pdf", base64: paperInput.pdf_base64 } : undefined,
            `Paper ${paperIndex} (${paperLabel})`
          );
        } catch (err) {
          papersFailed++;
          console.error(`Stage 0 (Segmenter) failed for paper ${paperIndex} (${paperLabel}) of run ${runId}:`, err);
          if (err instanceof LlmJsonParseError) {
            console.warn(
              `Paper ${paperIndex} (${paperLabel}) looks like it hit MAX_TOKENS -- the model's response was cut ` +
                "off before it could finish, either as invalid JSON (an unterminated string/array) or as a " +
                "syntactically complete but suspiciously short response (see jsonCompletion.ts's own " +
                "finishReason check). This is reported even though the pipeline already tried auto-splitting the " +
                "paper at section/question boundaries and retrying each piece (see paperSplitter.ts) -- that " +
                "failed too, which usually means either a single question within it is unusually large on its " +
                "own, or the paper has no boundary markers this can recognize (no SECTION/खण्ड headers, no plain " +
                "numbered questions). Splitting it by hand into smaller sections and submitting them as separate " +
                "files in one multi-file batch (see admin/archetype-miner/actions.ts) is the next thing to try."
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
