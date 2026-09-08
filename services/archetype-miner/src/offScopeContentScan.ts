import { getSupabaseClient } from "./supabaseClient.js";
import { getJsonCompletion } from "./jsonCompletion.js";
import { buildOffScopeContentScanPrompt } from "./prompts.js";
import { getActiveLlmProvider, type LlmProvider } from "./llm.js";
import { OFF_SCOPE_CONTENT_FLAG, type Archetype } from "./types.js";

// A retroactive sweep for the SAME thing pipelineRunner.ts's own
// OFF_SCOPE_CONTENT_FLAG check now catches going forward at mining time
// (see that flag's own comment) -- for content that reached the
// catalogue BEFORE that check existed. Confirmed live in production and
// corrected manually once already: a "Biology" archetype whose only
// supporting question was an English poem's own MCQ, and a Grade-12-
// tagged archetype whose only supporting question was actually Grade 11
// syllabus content. Neither of those was found by any automated process
// -- they turned up while investigating something else entirely, which
// is exactly why this exists: the same class of bug could be sitting
// anywhere else in the catalogue, unnoticed, until someone looks. Always
// scoped to one explicit board/grade/subject at a time (same reasoning
// cross-run merge and curriculum reconciliation already apply) -- a
// false positive here would wrongly discard real content and remove a
// legitimate archetype, so this is a deliberate, human-triggered sweep,
// never a blind whole-catalogue pass.
const PAGE_SIZE = 1000;
// Kept short deliberately -- a subject/grade sanity check needs only the
// GIST of a question, not its full derivation/case-study text, and a
// shorter per-item payload means more items fit in one batch.
const TEXT_TRUNCATE_LENGTH = 500;
const BATCH_SIZE = 40;
const MAX_TOKENS = 3000;

type SignatureRow = { run_id: string; question_id: string; signature: { flags?: string[] } };
type SegmentedQuestionRow = { run_id: string; question_id: string; question: { raw_text?: string; cleaned_text?: string } };
type Scope = { boardName: string; gradeName: string; subjectName: string };

function refKey(runId: string, questionId: string): string {
  return `${runId}:${questionId}`;
}

async function loadSignaturesInScope(scope: Scope): Promise<SignatureRow[]> {
  const supabase = getSupabaseClient();
  const rows: SignatureRow[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("archetype_question_signatures")
      .select("run_id, question_id, signature")
      .eq("education_context->curriculum_source->>name", scope.boardName)
      .eq("education_context->>grade_or_year", scope.gradeName)
      .eq("education_context->>subject_or_course", scope.subjectName)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      console.error("Off-scope content scan: failed to load question signatures:", error);
      break;
    }
    const page = (data ?? []) as SignatureRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  // Already-flagged rows were either caught by a previous scan or by
  // Stage 1 itself at mining time -- never re-flag/re-queue the same
  // question twice.
  return rows.filter((r) => !(r.signature?.flags ?? []).includes(OFF_SCOPE_CONTENT_FLAG));
}

async function loadTextByRef(scope: Scope): Promise<Map<string, string>> {
  const supabase = getSupabaseClient();
  const textByRef = new Map<string, string>();
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("archetype_segmented_questions")
      .select("run_id, question_id, question")
      .eq("education_context->curriculum_source->>name", scope.boardName)
      .eq("education_context->>grade_or_year", scope.gradeName)
      .eq("education_context->>subject_or_course", scope.subjectName)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      console.error("Off-scope content scan: failed to load segmented questions:", error);
      break;
    }
    const page = (data ?? []) as SegmentedQuestionRow[];
    for (const row of page) {
      const text = (row.question?.cleaned_text || row.question?.raw_text || "").trim();
      if (text) textByRef.set(refKey(row.run_id, row.question_id), text.slice(0, TEXT_TRUNCATE_LENGTH));
    }
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return textByRef;
}

type Candidate = { ref: string; runId: string; questionId: string; text: string };

async function loadCandidates(scope: Scope): Promise<Candidate[]> {
  const [signatures, textByRef] = await Promise.all([loadSignaturesInScope(scope), loadTextByRef(scope)]);
  const candidates: Candidate[] = [];
  for (const s of signatures) {
    const ref = refKey(s.run_id, s.question_id);
    const text = textByRef.get(ref);
    if (text) candidates.push({ ref, runId: s.run_id, questionId: s.question_id, text });
  }
  return candidates;
}

export type OffScopeScanPreview = { candidateQuestions: number };

// Counts only -- no LLM call, no writes.
export async function previewOffScopeContentScan(scope: Scope): Promise<OffScopeScanPreview> {
  const candidates = await loadCandidates(scope);
  return { candidateQuestions: candidates.length };
}

type Flagged = { ref: string; reason: string };

// Below this, a failing batch is skipped rather than bisected further.
const MIN_BISECTION_SIZE = 5;

async function requestFlagsOnce(batch: Candidate[], scope: Scope, provider: LlmProvider): Promise<Flagged[]> {
  const { data } = await getJsonCompletion({
    systemPrompt: buildOffScopeContentScanPrompt(),
    message: JSON.stringify({
      board: scope.boardName,
      grade: scope.gradeName,
      subject: scope.subjectName,
      questions: batch.map((c) => ({ ref: c.ref, text: c.text })),
    }),
    maxTokens: MAX_TOKENS,
    provider,
  });

  if (!Array.isArray(data)) {
    console.warn(`Off-scope content scan: response was not a JSON array for a batch of ${batch.length}.`);
    return [];
  }

  const validRefs = new Set(batch.map((c) => c.ref));
  const flagged: Flagged[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const f = item as Record<string, unknown>;
    if (typeof f.ref === "string" && validRefs.has(f.ref)) {
      flagged.push({ ref: f.ref, reason: typeof f.reason === "string" && f.reason.trim() ? f.reason.trim() : "Flagged as off-scope content." });
    }
  }
  return flagged;
}

// Same bisection-on-failure resilience as crossRunMerge.ts's own
// detectDuplicateClustersResilient, and for the same real reason -- this
// sends raw exam question TEXT (drug-abuse warnings, hazardous chemistry,
// sensitive social-science topics all appear in real past papers) through
// an LLM call, exactly the kind of legitimate textbook content that has
// already been confirmed, live, to trip Azure OpenAI's own content
// filter. Losing a whole batch to one poison-pill question would
// otherwise silently skip every OTHER question in it, indefinitely.
async function requestFlagsResilient(batch: Candidate[], scope: Scope, provider: LlmProvider): Promise<Flagged[]> {
  try {
    return await requestFlagsOnce(batch, scope, provider);
  } catch (err) {
    if (batch.length <= MIN_BISECTION_SIZE) {
      console.warn(`Off-scope content scan: batch of ${batch.length} failed and is too small to bisect further -- skipping:`, err);
      return [];
    }
    console.warn(`Off-scope content scan: batch of ${batch.length} failed -- bisecting to isolate the problem:`, err);
    const mid = Math.floor(batch.length / 2);
    const left = await requestFlagsResilient(batch.slice(0, mid), scope, provider);
    const right = await requestFlagsResilient(batch.slice(mid), scope, provider);
    return [...left, ...right];
  }
}

type ArchetypeRow = { run_id: string; archetype_id: string; archetype: Archetype; status: string; critic_decision: string | null };

// Reacts to one newly-flagged question within its own run: marks the
// signature, queues it for review, and looks at any currently-accepted
// archetype built on it. An archetype whose ENTIRE evidence is this one
// question is unambiguously invalid -- removed outright, same as the two
// confirmed cases already corrected manually. An archetype with OTHER,
// unflagged supporting questions too is NOT auto-removed (most of its
// evidence may still be perfectly legitimate) -- it's queued into the
// review queue instead (source: stage3_review_flag, the existing
// "archetype needs a human look" bucket) so a person decides whether to
// revise, remove, or leave it.
async function applyFlag(supabase: ReturnType<typeof getSupabaseClient>, flagged: Flagged, runId: string, questionId: string): Promise<void> {
  const { data: sigRow, error: sigError } = await supabase
    .from("archetype_question_signatures")
    .select("signature")
    .eq("run_id", runId)
    .eq("question_id", questionId)
    .maybeSingle();
  if (sigError || !sigRow) {
    console.error(`Off-scope content scan: failed to load signature ${runId}:${questionId} to flag it:`, sigError);
    return;
  }
  const signature = sigRow.signature as { flags?: string[] };
  const nextFlags = Array.from(new Set([...(signature.flags ?? []), OFF_SCOPE_CONTENT_FLAG]));
  const { error: updateError } = await supabase
    .from("archetype_question_signatures")
    .update({ signature: { ...signature, flags: nextFlags } })
    .eq("run_id", runId)
    .eq("question_id", questionId);
  if (updateError) {
    console.error(`Off-scope content scan: failed to flag signature ${runId}:${questionId}:`, updateError);
    return;
  }

  const { error: queueError } = await supabase.from("archetype_review_queue").insert({
    run_id: runId,
    source: "stage1_off_scope_content",
    reference_id: questionId,
    reason: `Off-scope content scan: ${flagged.reason}`,
    confidence: null,
    status: "pending",
  });
  if (queueError) console.error(`Off-scope content scan: failed to queue ${runId}:${questionId} for review:`, queueError);

  const { data: archetypeRows, error: archetypeError } = await supabase
    .from("archetypes")
    .select("run_id, archetype_id, archetype, status, critic_decision")
    .eq("run_id", runId)
    .in("status", ["reviewed", "final"])
    .in("critic_decision", ["KEEP", "REVISE", "ADD"]);
  if (archetypeError) {
    console.error(`Off-scope content scan: failed to check archetypes referencing ${runId}:${questionId}:`, archetypeError);
    return;
  }

  for (const row of (archetypeRows ?? []) as ArchetypeRow[]) {
    const supportingIds = row.archetype.supporting_question_ids ?? [];
    if (!supportingIds.includes(questionId)) continue;

    if (supportingIds.length === 1) {
      const { error } = await supabase
        .from("archetypes")
        .update({
          critic_decision: "REMOVE",
          archetype: {
            ...row.archetype,
            critic_decision: "REMOVE",
            critic_rationale: `Off-scope content scan: its only supporting question was flagged off-scope (${flagged.reason})`,
          },
          updated_at: new Date().toISOString(),
        })
        .eq("run_id", row.run_id)
        .eq("archetype_id", row.archetype_id);
      if (error) console.error(`Off-scope content scan: failed to remove archetype ${row.run_id}:${row.archetype_id}:`, error);
      else console.log(`Off-scope content scan: removed archetype "${row.archetype_id}" (${row.run_id}) -- its only evidence was off-scope.`);
    } else {
      const { error } = await supabase.from("archetype_review_queue").insert({
        run_id: row.run_id,
        source: "stage3_review_flag",
        reference_id: row.archetype_id,
        reason:
          `Off-scope content scan: 1 of ${supportingIds.length} supporting question(s) was flagged off-scope (${flagged.reason}) -- ` +
          "the rest may still be legitimate; needs a human decision on whether to keep, revise, or remove this archetype.",
        confidence: null,
        status: "pending",
      });
      if (error) console.error(`Off-scope content scan: failed to queue archetype ${row.run_id}:${row.archetype_id} for review:`, error);
    }
  }
}

export type OffScopeScanResult = { questionsScanned: number; questionsFlagged: number };

let scanInProgress = false;

export function isOffScopeContentScanInProgress(): boolean {
  return scanInProgress;
}

// Long-running (one LLM call per batch of up to 40 questions, across the
// whole scope) -- callers should fire this in the background, same
// posture as every other admin-triggered pass in this file's siblings.
export async function runOffScopeContentScan(scope: Scope): Promise<OffScopeScanResult> {
  if (scanInProgress) {
    throw new Error("An off-scope content scan is already in progress -- wait for it to finish before starting another.");
  }
  scanInProgress = true;
  try {
    const supabase = getSupabaseClient();
    const candidates = await loadCandidates(scope);

    console.log(
      `Off-scope content scan: checking ${candidates.length} question(s) for ${scope.subjectName} (${scope.boardName}, grade ${scope.gradeName})...`
    );

    if (candidates.length === 0) {
      return { questionsScanned: 0, questionsFlagged: 0 };
    }

    const provider = getActiveLlmProvider();
    const batches: Candidate[][] = [];
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) batches.push(candidates.slice(i, i + BATCH_SIZE));

    let questionsFlagged = 0;
    for (const batch of batches) {
      const flagged = await requestFlagsResilient(batch, scope, provider);
      const byRef = new Map(batch.map((c) => [c.ref, c]));
      for (const f of flagged) {
        const candidate = byRef.get(f.ref);
        if (!candidate) continue; // a ref the model invented -- nothing safe to act on
        await applyFlag(supabase, f, candidate.runId, candidate.questionId);
        questionsFlagged++;
      }
    }

    console.log(
      `Off-scope content scan: done -- ${candidates.length} question(s) scanned, ${questionsFlagged} flagged as off-scope ` +
        "(see the review queue for each one's own reason)."
    );

    return { questionsScanned: candidates.length, questionsFlagged };
  } finally {
    scanInProgress = false;
  }
}
