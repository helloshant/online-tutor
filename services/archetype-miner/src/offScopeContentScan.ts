import { getSupabaseClient } from "./supabaseClient.js";
import { getJsonCompletion } from "./jsonCompletion.js";
import { buildOffScopeContentScanPrompt } from "./prompts.js";
import { getActiveLlmProvider, type LlmProvider } from "./llm.js";
import { OFF_SCOPE_CONTENT_FLAG, OFF_SCOPE_CHECKED_FLAG, type Archetype } from "./types.js";
import { loadAcceptableChapterValues } from "./curriculumReconciliation.js";

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
//
// Confirmed live in production, repeatedly, before this settled into its
// current, deliberately more conservative shape: without real ground
// truth to check against, the model's own vague notion of "general
// [subject]" is not reliable -- it repeatedly flagged genuine chapters of
// the declared subject (Biotechnology, Evolution, Ecology, drug-abuse
// content under Human Health and Disease, all real Grade 12 CBSE
// Biology) as if they belonged to some OTHER subject entirely, reasoning
// things like "Biotechnology, not general Biology" or "Anthropology, not
// core Biology." Feeding it the real syllabus chapter list as ground
// truth (reusing curriculumReconciliation.ts's own
// loadAcceptableChapterValues()) cut the false-positive rate drastically,
// but even after that fix, across two more scan runs, EVERY flag was
// still a false positive on real CBSE case-study content -- the same
// archetype had to be restored by hand three separate times. Flagging a
// SIGNATURE stays useful (it's a cheap, reversible, human-reviewable
// signal); acting on that flag by auto-removing an archetype does not --
// see applyFlag's own comment for why that path was removed entirely.
const PAGE_SIZE = 1000;
// Kept short deliberately -- a subject/grade sanity check needs only the
// GIST of a question, not its full derivation/case-study text, and a
// shorter per-item payload means more items fit in one batch.
const TEXT_TRUNCATE_LENGTH = 500;
const BATCH_SIZE = 40;
const MAX_TOKENS = 3000;

type SignatureRow = { run_id: string; question_id: string; signature: { flags?: string[]; curriculum?: { chapter?: string } } };

function normalize(s: string): string {
  return s.trim().toLowerCase();
}
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
  // question twice. Already-checked-and-clean rows (OFF_SCOPE_CHECKED_FLAG)
  // got a genuine LLM verdict on a previous pass and it was "not off-scope"
  // -- see that flag's own comment for why this is tracked at all.
  return rows.filter((r) => {
    const flags = r.signature?.flags ?? [];
    return !flags.includes(OFF_SCOPE_CONTENT_FLAG) && !flags.includes(OFF_SCOPE_CHECKED_FLAG);
  });
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

type Candidate = { ref: string; runId: string; questionId: string; text: string; signature: SignatureRow["signature"] };

// The single biggest source of every false positive found so far: asking
// an LLM to re-derive "does this content match the subject" from raw
// text, for EVERY question, even the ones already correctly classified.
// Stage 1 already assigned curriculum.chapter to every question at mining
// time -- when that stored value is an EXACT match to a real syllabus
// entry (the same ground truth the LLM check below is given), the
// question is unambiguously in-scope BY CONSTRUCTION and needs no LLM
// judgment at all: a plain string comparison against syllabus_topics
// can't suffer a vocabulary-override mistake the way free-text reasoning
// can. This is the reason a question about osmosis or vitamin deficiency
// diseases -- already correctly classified as "Solutions" or
// "Biomolecules" -- should never have reached the LLM step in the first
// place. Only a question whose stored chapter does NOT already match
// (either genuinely off-scope content, or a chapter-name variant
// curriculum reconciliation hasn't normalized yet) is genuinely
// ambiguous enough to need the LLM's judgment.
async function loadCandidates(scope: Scope, syllabus: string[]): Promise<Candidate[]> {
  const [signatures, textByRef] = await Promise.all([loadSignaturesInScope(scope), loadTextByRef(scope)]);
  const syllabusKeys = new Set(syllabus.map(normalize));
  const candidates: Candidate[] = [];
  for (const s of signatures) {
    const chapter = s.signature?.curriculum?.chapter?.trim();
    if (chapter && syllabusKeys.has(normalize(chapter))) continue;
    const ref = refKey(s.run_id, s.question_id);
    const text = textByRef.get(ref);
    if (text) candidates.push({ ref, runId: s.run_id, questionId: s.question_id, text, signature: s.signature });
  }
  return candidates;
}

export type OffScopeScanPreview = { candidateQuestions: number };

// Counts only -- no LLM call, no writes.
export async function previewOffScopeContentScan(scope: Scope): Promise<OffScopeScanPreview> {
  const syllabus = await loadAcceptableChapterValues(scope);
  const candidates = await loadCandidates(scope, syllabus);
  return { candidateQuestions: candidates.length };
}

type Flagged = { ref: string; reason: string };

// Below this, a failing batch is skipped rather than bisected further.
const MIN_BISECTION_SIZE = 5;

async function requestFlagsOnce(batch: Candidate[], scope: Scope, syllabus: string[], provider: LlmProvider): Promise<Flagged[]> {
  const { data } = await getJsonCompletion({
    systemPrompt: buildOffScopeContentScanPrompt(),
    message: JSON.stringify({
      board: scope.boardName,
      grade: scope.gradeName,
      subject: scope.subjectName,
      // The real, authoritative chapter/topic list for this scope -- see
      // this file's own top comment and the prompt's own INPUT section
      // for why this is the fix for the false positives already
      // confirmed live. Omitted (empty array) falls back to the model's
      // own subject-matter knowledge, same as when no taxonomy exists.
      syllabus,
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
//
// Reports `evaluated` (the candidates that actually got a real verdict)
// separately from `flagged`, because those are NOT the same set: a
// candidate that's evaluated and not flagged is confirmed clean and safe
// to mark with OFF_SCOPE_CHECKED_FLAG, but a candidate a poison-pill batch
// gave up on was never evaluated at all -- marking THAT clean would hide
// it from every future pass despite nobody ever having actually looked.
async function requestFlagsResilient(
  batch: Candidate[],
  scope: Scope,
  syllabus: string[],
  provider: LlmProvider
): Promise<{ flagged: Flagged[]; evaluated: Candidate[] }> {
  try {
    const flagged = await requestFlagsOnce(batch, scope, syllabus, provider);
    return { flagged, evaluated: batch };
  } catch (err) {
    if (batch.length <= MIN_BISECTION_SIZE) {
      console.warn(`Off-scope content scan: batch of ${batch.length} failed and is too small to bisect further -- skipping:`, err);
      return { flagged: [], evaluated: [] };
    }
    console.warn(`Off-scope content scan: batch of ${batch.length} failed -- bisecting to isolate the problem:`, err);
    const mid = Math.floor(batch.length / 2);
    const left = await requestFlagsResilient(batch.slice(0, mid), scope, syllabus, provider);
    const right = await requestFlagsResilient(batch.slice(mid), scope, syllabus, provider);
    return { flagged: [...left.flagged, ...right.flagged], evaluated: [...left.evaluated, ...right.evaluated] };
  }
}

type ArchetypeRow = { run_id: string; archetype_id: string; archetype: Archetype; status: string; critic_decision: string | null };

// Reacts to one newly-flagged question within its own run: marks the
// signature, queues it for review, and looks at any currently-accepted
// archetype built on it.
//
// Every affected archetype is queued for a HUMAN decision now -- never
// auto-removed, regardless of whether the flagged question is its only
// supporting evidence. This was NOT the original design: an archetype
// whose entire evidence was one flagged question used to be removed
// automatically. That auto-remove path is exactly what caused real
// damage, confirmed live, repeatedly: across four consecutive scan runs
// after the syllabus-grounding fix landed, every single flag in the last
// two runs was a false positive on real, already-correctly-classified
// CBSE case-study content (Human Health and Disease / Drug and Alcohol
// Abuse content framed around real-world scenarios the model kept
// mistaking for a different field), and the SAME archetype
// ("explain-impact-agricultural-practice-ecosystem") got wrongly
// auto-removed three separate times, having to be restored by hand each
// time. The flagging judgment itself has not proven reliable enough to
// trust for automatic, irreversible action -- it remains useful for
// SURFACING candidates a human can quickly confirm or reject, which is
// exactly what still happens here.
// Records "an LLM actually looked at this and it's fine" so this same
// question doesn't keep costing a fresh LLM call, and doesn't keep
// inflating the "questions left to check" count, on every future pass or
// preview over this scope -- see OFF_SCOPE_CHECKED_FLAG's own comment.
// Uses the signature already loaded for this candidate (moments ago, by
// the same scan run) rather than re-fetching it per question -- the same
// no-concurrent-writer assumption the rest of this scan already relies on,
// and the only way to avoid turning a large scope's clean pass into
// thousands of extra round trips just to confirm nothing changed.
async function markChecked(supabase: ReturnType<typeof getSupabaseClient>, candidate: Candidate): Promise<void> {
  const signature = candidate.signature as { flags?: string[] };
  const nextFlags = Array.from(new Set([...(signature.flags ?? []), OFF_SCOPE_CHECKED_FLAG]));
  const { error } = await supabase
    .from("archetype_question_signatures")
    .update({ signature: { ...signature, flags: nextFlags } })
    .eq("run_id", candidate.runId)
    .eq("question_id", candidate.questionId);
  if (error) console.error(`Off-scope content scan: failed to mark ${candidate.ref} as checked:`, error);
}

const OFF_SCOPE_ARCHETYPE_REVIEW_SOURCE = "stage3_review_flag";
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

    // Always queued for a human, never auto-removed -- see this
    // function's own top comment for why. The message still distinguishes
    // "this is its only evidence" from "N of M" so a reviewer can
    // prioritize the sole-evidence cases (the ones that would previously
    // have vanished silently) without this code guessing on their behalf.
    const evidenceNote =
      supportingIds.length === 1
        ? "this is its ONLY supporting question"
        : `1 of ${supportingIds.length} supporting question(s)`;
    const { error } = await supabase.from("archetype_review_queue").insert({
      run_id: row.run_id,
      source: OFF_SCOPE_ARCHETYPE_REVIEW_SOURCE,
      reference_id: row.archetype_id,
      reason:
        `Off-scope content scan: ${evidenceNote} was flagged off-scope (${flagged.reason}) -- needs a human decision on whether to ` +
        "keep, revise, or remove this archetype (not auto-removed; this scan's flagging has produced confirmed false positives on real content).",
      confidence: null,
      status: "pending",
    });
    if (error) console.error(`Off-scope content scan: failed to queue archetype ${row.run_id}:${row.archetype_id} for review:`, error);
  }
}

export type OffScopeScanResult = { iterationsRun: number; questionsScanned: number; questionsFlagged: number };

let scanInProgress = false;

export function isOffScopeContentScanInProgress(): boolean {
  return scanInProgress;
}

// Every candidate a pass actually evaluates gets marked -- flagged
// (OFF_SCOPE_CONTENT_FLAG) or confirmed clean (OFF_SCOPE_CHECKED_FLAG) --
// so a later iteration's own re-scan of "the remaining pool" only ever
// picks up candidates NO pass has looked at yet: newly-mined questions
// added mid-scan, or ones a poison-pill bisection had to give up on
// without a verdict (see requestFlagsResilient's own comment). In
// practice that means most single-click runs settle in one real iteration
// with the rest finding nothing left to do -- which is the point: this
// used to re-examine the SAME already-confirmed-clean content on every
// iteration (and again on every future "Scan now" click) hoping a retry
// might catch something the model missed, but that's exactly the
// unreliable judgment this file's other comments already document at
// length; a plain "was this ever actually checked" marker is what makes
// repeat scans over the same scope cheap and their own preview counts
// honest. Capped low (unlike cross-run merge/curriculum reconciliation's
// own higher caps) since a real iteration here is a full LLM pass over
// tens of batches, not a cheap one.
const MAX_ITERATIONS = 3;

// Long-running (one LLM call per batch of up to 40 questions, per
// iteration, across the whole remaining candidate pool) -- callers should
// fire this in the background, same posture as every other admin-
// triggered pass in this file's siblings.
export async function runOffScopeContentScan(scope: Scope): Promise<OffScopeScanResult> {
  if (scanInProgress) {
    throw new Error("An off-scope content scan is already in progress -- wait for it to finish before starting another.");
  }
  scanInProgress = true;
  try {
    // Fetched once for the whole scan, not per iteration or per batch --
    // the real syllabus for this scope doesn't change mid-run. Empty when
    // this app has no syllabus_topics catalogue for this exact scope; the
    // prompt itself falls back to the model's own subject knowledge then,
    // same posture curriculum reconciliation already accepts.
    const syllabus = await loadAcceptableChapterValues(scope);
    console.log(
      `Off-scope content scan: grounding against ${syllabus.length} real syllabus chapter/topic value(s) for ${scope.subjectName} ` +
        `(${scope.boardName}, grade ${scope.gradeName})` +
        (syllabus.length === 0 ? " -- none found, falling back to the model's own subject knowledge." : ".")
    );

    const provider = getActiveLlmProvider();
    const total: OffScopeScanResult = { iterationsRun: 0, questionsScanned: 0, questionsFlagged: 0 };

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      const pass = await runOffScopeContentScanOnePass(scope, syllabus, provider);
      total.iterationsRun = iteration;
      total.questionsScanned += pass.questionsScanned;
      total.questionsFlagged += pass.questionsFlagged;

      console.log(
        `Off-scope content scan: iteration ${iteration}/${MAX_ITERATIONS} for ${scope.subjectName} (${scope.boardName}, ` +
          `grade ${scope.gradeName}) -- ${pass.questionsScanned} scanned, ${pass.questionsFlagged} flagged this pass.`
      );

      // Converged -- a clean pass with nothing new to flag. Stop rather
      // than spending the rest of the iteration budget re-scanning the
      // same now-confirmed-clean pool.
      if (pass.questionsFlagged === 0) break;
    }

    console.log(
      `Off-scope content scan: done -- ${total.iterationsRun} iteration(s), ${total.questionsFlagged} total question(s) flagged as ` +
        "off-scope (see the review queue for each one's own reason)."
    );

    return total;
  } finally {
    scanInProgress = false;
  }
}

async function runOffScopeContentScanOnePass(
  scope: Scope,
  syllabus: string[],
  provider: LlmProvider
): Promise<{ questionsScanned: number; questionsFlagged: number }> {
  const supabase = getSupabaseClient();
  const candidates = await loadCandidates(scope, syllabus);
  if (candidates.length === 0) return { questionsScanned: 0, questionsFlagged: 0 };

  const batches: Candidate[][] = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) batches.push(candidates.slice(i, i + BATCH_SIZE));

  let questionsFlagged = 0;
  let questionsScanned = 0;
  for (const batch of batches) {
    const { flagged, evaluated } = await requestFlagsResilient(batch, scope, syllabus, provider);
    questionsScanned += evaluated.length;
    const byRef = new Map(batch.map((c) => [c.ref, c]));
    const flaggedRefs = new Set<string>();
    for (const f of flagged) {
      const candidate = byRef.get(f.ref);
      if (!candidate) continue; // a ref the model invented -- nothing safe to act on
      await applyFlag(supabase, f, candidate.runId, candidate.questionId);
      flaggedRefs.add(f.ref);
      questionsFlagged++;
    }
    // Everything the model actually evaluated and did NOT flag is
    // confirmed clean -- mark it so it never comes back as a candidate.
    // Anything bisection gave up on (not in `evaluated`) is deliberately
    // left unmarked -- see requestFlagsResilient's own comment.
    await Promise.all(
      evaluated.filter((c) => !flaggedRefs.has(c.ref)).map((c) => markChecked(supabase, c))
    );
  }

  return { questionsScanned, questionsFlagged };
}
