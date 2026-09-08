import { getSupabaseClient } from "./supabaseClient.js";
import { getJsonCompletion } from "./jsonCompletion.js";
import { buildCrossRunMergePrompt } from "./prompts.js";
import { getActiveLlmProvider, type LlmProvider } from "./llm.js";
import type { Archetype } from "./types.js";
import { toYear } from "./textCoercion.js";

// A genuinely different duplicate-detection gap from anything Stage 3 (or
// its own recovery, see stage3Recovery.ts) already covers: Stage 3's own
// MERGE responsibility only ever compares candidates WITHIN one mining
// run's own batch -- it has no visibility into any OTHER run's archetypes
// at all (an explicit, documented trade-off, see stage3Critic.ts's own
// batching comment). So the same reasoning pattern, mined independently
// across several separate runs (the same chapter submitted as several
// different past papers, most commonly), produces several textually
// distinct (differently-worded) archetypes with no MERGE ever proposed
// between them. Confirmed directly in production: "Calculate conditional
// probability using Bayes' theorem" existed as 10 separate archetypes
// across 10 different runs; the display-time exact-name dedup in
// archetypeExercises.ts already fixes the free half of this (identical
// wording), but a near-duplicate with genuinely different wording needs
// real semantic judgment -- this is that judgment, an explicit,
// deliberate, one-off cost (per the human decision that led to this file
// existing at all), scoped to one board/grade/subject at a time -- never
// a blind whole-catalogue sweep, same reasoning server.ts's own family-
// mining route already requires an explicit subject_or_course for.
const ACCEPTED_STATUSES = ["reviewed", "final"];
const ACCEPTED_DECISIONS = ["KEEP", "REVISE", "ADD"];
// The largest batch sent to any ONE LLM call (see processChapterGroup's
// own comment for what happens to a chapter group larger than this -- it
// gets reduced across several rounds now, not skipped; this used to be a
// hard skip boundary before that existed). Went 60 -> 200 after the first
// wrong guess (60, based on the largest cross-run duplicate COUNT seen at
// the time, Bayes' theorem's 10 copies) got disproven by real chapters at
// 71/79/113 archetypes. This is safe to keep fairly high, unlike the
// earlier per-item-retyping bugs this session found (Stage 0/2/3, the
// backfill): the prompt explicitly tells the model to OMIT any archetype
// with no duplicate, so a call's OUTPUT size scales with how many genuine
// duplicate clusters actually exist within its own batch, not with the
// batch's own input size.
const MAX_GROUP_SIZE = 200;
const MAX_TOKENS = 8000;

type AcceptedRow = { run_id: string; archetype_id: string; archetype: Archetype };
type SignatureRow = { run_id: string; question_id: string; signature: { curriculum?: { chapter?: string } } };

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

// Same "most common chapter among this archetype's own supporting
// questions" derivation archetypeCoverage.ts's own getArchetypesWithChapterTopic
// and this service's stage3Recovery.ts sibling files already use --
// reimplemented here rather than imported since each service in this repo
// is independently deployed with no shared package (see this repo's own
// established convention for small duplicated helpers across service
// boundaries).
function mostCommon(values: string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

async function loadAcceptedWithChapter(params: {
  boardName: string;
  gradeName: string;
  subjectName: string;
}): Promise<{ row: AcceptedRow; chapter: string }[]> {
  const supabase = getSupabaseClient();
  const { data: rows, error } = await supabase
    .from("archetypes")
    .select("run_id, archetype_id, archetype")
    .eq("education_context->curriculum_source->>name", params.boardName)
    .eq("education_context->>grade_or_year", params.gradeName)
    .eq("education_context->>subject_or_course", params.subjectName)
    .in("status", ACCEPTED_STATUSES)
    .in("critic_decision", ACCEPTED_DECISIONS);

  if (error) {
    console.error("Cross-run merge: failed to load accepted archetypes:", error);
    return [];
  }
  if (!rows || rows.length === 0) return [];

  const typedRows = rows as AcceptedRow[];
  const runIds = Array.from(new Set(typedRows.map((r) => r.run_id)));
  const { data: sigRows, error: sigError } = await supabase
    .from("archetype_question_signatures")
    .select("run_id, question_id, signature")
    .in("run_id", runIds);
  if (sigError) {
    console.error("Cross-run merge: failed to load signatures for chapter resolution:", sigError);
    return [];
  }

  const chapterByQuestion = new Map<string, string>();
  for (const s of (sigRows ?? []) as SignatureRow[]) {
    const chapter = s.signature?.curriculum?.chapter;
    if (chapter) chapterByQuestion.set(`${s.run_id}:${s.question_id}`, chapter);
  }

  return typedRows.map((row) => {
    const chapters = row.archetype.supporting_question_ids
      .map((qid) => chapterByQuestion.get(`${row.run_id}:${qid}`))
      .filter((c): c is string => Boolean(c));
    return { row, chapter: mostCommon(chapters) ?? "(unresolved chapter)" };
  });
}

// Only chapters with archetypes from MORE than one run have any chance of
// a cross-run duplicate at all -- a chapter mined within a single run
// already went through Stage 3's own within-run MERGE detection.
function groupByChapterCrossRun(rows: { row: AcceptedRow; chapter: string }[]): Map<string, AcceptedRow[]> {
  const byChapter = new Map<string, AcceptedRow[]>();
  for (const { row, chapter } of rows) {
    const key = normalize(chapter);
    const group = byChapter.get(key);
    if (group) group.push(row);
    else byChapter.set(key, [row]);
  }
  const result = new Map<string, AcceptedRow[]>();
  for (const [chapter, group] of byChapter) {
    if (group.length > 1 && new Set(group.map((r) => r.run_id)).size > 1) {
      result.set(chapter, group);
    }
  }
  return result;
}

export type CrossRunMergePreview = { chapterGroups: number; archetypesInvolved: number };

// Counts only -- no LLM calls, no writes. Lets an admin see the real scope
// (and therefore roughly the cost) for this one board/grade/subject scope
// before committing to the run below.
export async function previewCrossRunMerge(params: {
  boardName: string;
  gradeName: string;
  subjectName: string;
}): Promise<CrossRunMergePreview> {
  const rows = await loadAcceptedWithChapter(params);
  const groups = groupByChapterCrossRun(rows);
  let archetypesInvolved = 0;
  for (const g of groups.values()) archetypesInvolved += g.length;
  return { chapterGroups: groups.size, archetypesInvolved };
}

type Cluster = { memberRefs: string[]; rationale: string };

// Only ever called on a batch already guaranteed <= MAX_GROUP_SIZE (see
// processChapterGroup below, the only caller) -- the length check here is
// a defensive invariant guard, not the primary "too big" handling path
// anymore (that's now real reduction, not a skip).
// The raw single API call -- throws on any failure (a malformed response,
// a transient API error surviving getJsonCompletion's own internal
// retries, or a content-filter rejection), never swallows one itself.
// Only ever called by detectDuplicateClustersResilient below, which is
// what every other caller in this file actually uses.
async function detectDuplicateClustersOnce(group: AcceptedRow[], provider: LlmProvider): Promise<Cluster[]> {
  if (group.length > MAX_GROUP_SIZE) {
    console.warn(`Cross-run merge: internal invariant violated -- a batch of ${group.length} reached detectDuplicateClustersOnce (cap ${MAX_GROUP_SIZE}).`);
    return [];
  }

  const { data } = await getJsonCompletion({
    systemPrompt: buildCrossRunMergePrompt(),
    message: JSON.stringify(
      group.map((r) => ({
        ref: `${r.run_id}:${r.archetype_id}`,
        name: r.archetype.name,
        concept: r.archetype.concept,
        learning_objective: r.archetype.learning_objective,
        invariant_reasoning_structure: r.archetype.invariant_reasoning_structure,
      }))
    ),
    maxTokens: MAX_TOKENS,
    provider,
  });

  if (!Array.isArray(data)) {
    console.warn(`Cross-run merge: response was not a JSON array for a group of ${group.length} archetype(s).`);
    return [];
  }

  const clusters: Cluster[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const c = item as Record<string, unknown>;
    if (Array.isArray(c.member_refs) && c.member_refs.length >= 2 && c.member_refs.every((r) => typeof r === "string")) {
      clusters.push({
        memberRefs: c.member_refs as string[],
        rationale: typeof c.rationale === "string" && c.rationale.trim() ? c.rationale : "Cross-run duplicate of the same reasoning pattern.",
      });
    }
  }
  return clusters;
}

// Below this, a failing batch is skipped rather than bisected further --
// two archetypes is as small as a "duplicate cluster" can meaningfully
// get, so there's nothing smaller worth isolating down to.
const MIN_BISECTION_SIZE = 4;

// Confirmed directly in production: a real batch (73 CBSE Chemistry
// archetypes -- syllabus content on drugs/toxic compounds/hazardous
// reactions routinely trips this even though it's entirely legitimate
// textbook material) failed with Azure OpenAI's content_filter rejection.
// The old behavior (catch, log, return []) skipped the WHOLE batch --
// safe (fails open, no crash), but silent and, worse, potentially
// PERMANENT: nothing about a content-filter-triggering archetype's own
// text changes between passes, so the same batch would very likely trip
// the same filter on every future iteration too, meaning that batch's
// real duplicates might never get checked at all, indefinitely, with no
// visible sign anything was ever missed.
//
// Bisects on any failure instead: split the batch in half and retry each
// half independently, recursing down until either a half succeeds (most
// of a large batch usually isn't what tripped the filter -- often just
// one or two archetypes' own wording are the actual cause) or it's too
// small to usefully split further (MIN_BISECTION_SIZE), at which point
// that specific small remainder is skipped and logged by name so an
// admin can see exactly what was excluded, rather than an opaque "batch
// of 73 failed." Trade-off accepted: a genuine duplicate pair that
// happens to straddle a bisection split won't be caught in THIS call --
// same trade-off the reduction rounds' own reshuffling already accepts,
// and for the same reason it's fine here too: a later top-level iteration
// (different shuffling) gets another chance at it.
async function detectDuplicateClustersResilient(batch: AcceptedRow[], provider: LlmProvider): Promise<Cluster[]> {
  try {
    return await detectDuplicateClustersOnce(batch, provider);
  } catch (err) {
    if (batch.length <= MIN_BISECTION_SIZE) {
      console.warn(
        `Cross-run merge: batch of ${batch.length} archetype(s) failed and is too small to bisect further -- ` +
          `skipping (likely source: ${batch.map((r) => `"${r.archetype.name}"`).join(", ")}):`,
        err
      );
      return [];
    }

    console.warn(`Cross-run merge: batch of ${batch.length} archetype(s) failed -- bisecting to isolate the problem:`, err);
    const mid = Math.floor(batch.length / 2);
    const left = await detectDuplicateClustersResilient(batch.slice(0, mid), provider);
    const right = await detectDuplicateClustersResilient(batch.slice(mid), provider);
    return [...left, ...right];
  }
}

// Folds every absorbed archetype's own numeric evidence into the
// survivor's -- deliberately NOT supporting_question_ids: an id in that
// array is only unique WITHIN its own archetype's single stored run_id
// (see 0041_archetype_miner_run_scoped_ids.sql), so blending ids from a
// DIFFERENT run into the survivor's own array would silently corrupt
// every downstream lookup that resolves `${row.run_id}:${qid}` pairs
// assuming every id in the array belongs to that one run. The plain
// aggregate numbers/lists below carry no such run-scoping risk.
function mergeArchetypeStats(target: Archetype["stats"], absorbed: Archetype["stats"][]): Archetype["stats"] {
  // toYear guards against the same mixed number/numeric-string years
  // seen in production (see textCoercion.ts's own comment) -- an
  // unguarded `new Set` here would silently carry a duplicate-looking
  // year through a merge instead of actually deduping it.
  const years = new Set((target.years_observed ?? []).map(toYear).filter((y): y is number => y !== null));
  let questionCount = target.question_count ?? 0;
  const marks: Record<string, number> = { ...target.marks_distribution };
  const formats: Record<string, number> = { ...target.formats };
  const difficulty = { ...target.difficulty_distribution };
  const gradeYear: Record<string, number> = { ...target.grade_or_year_distribution };

  for (const s of absorbed) {
    for (const y of s.years_observed ?? []) {
      const yr = toYear(y);
      if (yr !== null) years.add(yr);
    }
    questionCount += s.question_count ?? 0;
    for (const [k, v] of Object.entries(s.marks_distribution ?? {})) marks[k] = (marks[k] ?? 0) + v;
    for (const [k, v] of Object.entries(s.formats ?? {})) formats[k] = (formats[k] ?? 0) + v;
    difficulty.Easy += s.difficulty_distribution?.Easy ?? 0;
    difficulty.Medium += s.difficulty_distribution?.Medium ?? 0;
    difficulty.Hard += s.difficulty_distribution?.Hard ?? 0;
    for (const [k, v] of Object.entries(s.grade_or_year_distribution ?? {})) gradeYear[k] = (gradeYear[k] ?? 0) + v;
  }

  const sortedYears = Array.from(years).sort((a, b) => a - b);
  return {
    question_count: questionCount,
    years_observed: sortedYears,
    first_observed_year: sortedYears[0] ?? null,
    last_observed_year: sortedYears[sortedYears.length - 1] ?? null,
    marks_distribution: marks,
    formats,
    difficulty_distribution: difficulty,
    grade_or_year_distribution: gradeYear,
  };
}

export type CrossRunMergeResult = {
  iterationsRun: number;
  chapterGroupsChecked: number;
  clustersFound: number;
  archetypesMerged: number;
};

// A single top-level call can genuinely need several iterations to reach a
// clean 0 -- confirmed directly in production: a chapter group can now run
// up to MAX_GROUP_SIZE (200) archetypes in one LLM call, and reliably
// spotting every genuine duplicate in a batch that large, every single
// time, isn't realistic for one pass -- five consecutive real runs against
// the same scope found 51, 30, 36, 28, 23 clusters in a row, including one
// FLAT repeat (30 then 36, not a strictly shrinking queue) rather than a
// clean converge-to-zero. That's ordinary model non-determinism sampling a
// different partial subset of the true duplicate set each call, not a
// bug -- but it means an admin manually re-clicking "Run merge now" over
// and over was doing exactly the right thing, just by hand. This bounds
// how many iterations one call will do that automatically before it were
// to loop forever chasing a vanishingly rare last catch.
const MAX_ITERATIONS = 8;

let mergeInProgress = false;

export function isCrossRunMergeInProgress(): boolean {
  return mergeInProgress;
}

// Long-running (up to MAX_ITERATIONS passes, each with one LLM call per
// chapter group with cross-run archetypes) -- callers should fire this in
// the background, not await it inline in a request handler (see
// server.ts's own POST route), and should check isCrossRunMergeInProgress()
// first (that route does).
export async function runCrossRunMerge(params: {
  boardName: string;
  gradeName: string;
  subjectName: string;
}): Promise<CrossRunMergeResult> {
  if (mergeInProgress) {
    throw new Error("A cross-run merge pass is already running -- wait for it to finish before starting another.");
  }
  mergeInProgress = true;
  try {
    const total: CrossRunMergeResult = { iterationsRun: 0, chapterGroupsChecked: 0, clustersFound: 0, archetypesMerged: 0 };
    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      const pass = await runCrossRunMergeOnePass(params);
      total.iterationsRun = iteration;
      total.chapterGroupsChecked = pass.chapterGroupsChecked; // same 29-ish chapters re-scanned each pass, not additive
      total.clustersFound += pass.clustersFound;
      total.archetypesMerged += pass.archetypesMerged;

      console.log(
        `Cross-run merge: iteration ${iteration}/${MAX_ITERATIONS} done -- ${pass.clustersFound} cluster(s), ` +
          `${pass.archetypesMerged} archetype(s) merged this pass.`
      );

      // Converged -- a clean pass with nothing left to merge. Stop rather
      // than spending MAX_ITERATIONS regardless once the real signal is
      // already "nothing more to find."
      if (pass.archetypesMerged === 0) break;
    }

    console.log(
      `Cross-run merge: fully done after ${total.iterationsRun} iteration(s) for ${params.subjectName} ` +
        `(${params.boardName}, grade ${params.gradeName}) -- ${total.clustersFound} total cluster(s) found, ` +
        `${total.archetypesMerged} total archetype(s) merged away.` +
        (total.iterationsRun >= MAX_ITERATIONS
          ? " Hit the iteration cap without reaching a clean pass -- run it again manually if you want to keep chasing the (likely small) remaining tail."
          : "")
    );

    return total;
  } finally {
    mergeInProgress = false;
  }
}

type GroupPassResult = { clustersFound: number; archetypesMerged: number; survivors: AcceptedRow[] };

// One LLM call (via detectDuplicateClusters) over a batch already
// guaranteed <= MAX_GROUP_SIZE, plus applying whatever clusters it finds.
// Returns the batch's own SURVIVORS (everything not absorbed into another
// member this call) so a caller reducing an oversized chapter across
// several rounds (see processChapterGroup) can pool them into the next,
// smaller round.
async function processBatch(
  chapter: string,
  batch: AcceptedRow[],
  provider: LlmProvider,
  supabase: ReturnType<typeof getSupabaseClient>
): Promise<GroupPassResult> {
  const byRef = new Map<string, AcceptedRow>();
  for (const row of batch) byRef.set(`${row.run_id}:${row.archetype_id}`, row);

  const clusters = await detectDuplicateClustersResilient(batch, provider);
  const absorbedRefs = new Set<string>();
  let clustersFound = 0;
  let archetypesMerged = 0;

  for (const cluster of clusters) {
    const members = cluster.memberRefs.map((ref) => byRef.get(ref)).filter((m): m is AcceptedRow => Boolean(m));
    // A ref the model invented, or a cluster that resolved down to fewer
    // than 2 real rows once unresolvable refs are dropped -- there is
    // nothing safe to merge left, skip it rather than guessing.
    if (members.length < 2) continue;
    clustersFound++;

    const survivor = members.reduce((best, m) =>
      (m.archetype.stats?.question_count ?? 0) > (best.archetype.stats?.question_count ?? 0) ? m : best
    );
    const absorbed = members.filter((m) => m !== survivor);

    const mergedStats = mergeArchetypeStats(survivor.archetype.stats, absorbed.map((m) => m.archetype.stats));
    const { error: survivorErr } = await supabase
      .from("archetypes")
      .update({ archetype: { ...survivor.archetype, stats: mergedStats }, updated_at: new Date().toISOString() })
      .eq("run_id", survivor.run_id)
      .eq("archetype_id", survivor.archetype_id);
    if (survivorErr) {
      // Don't mark the absorbed members MERGE if the survivor itself
      // didn't save -- that would lose their evidence into a survivor
      // that never actually received it.
      console.error(`Cross-run merge: failed to update survivor ${survivor.run_id}:${survivor.archetype_id}:`, survivorErr);
      continue;
    }
    // Reflect the merged stats on the in-memory row too -- a LATER
    // reduction round may pool this same survivor back in, and it should
    // carry forward what it just absorbed, not the stale pre-merge stats
    // still sitting in `batch`.
    survivor.archetype = { ...survivor.archetype, stats: mergedStats };

    for (const m of absorbed) {
      const mergedArchetype: Archetype = {
        ...m.archetype,
        critic_decision: "MERGE",
        merge_target_id: `${survivor.run_id}:${survivor.archetype_id}`,
        critic_rationale: `Cross-run duplicate merge (chapter "${chapter}"): ${cluster.rationale}`,
      };
      const { error } = await supabase
        .from("archetypes")
        .update({ archetype: mergedArchetype, critic_decision: "MERGE", updated_at: new Date().toISOString() })
        .eq("run_id", m.run_id)
        .eq("archetype_id", m.archetype_id);
      if (error) {
        console.error(`Cross-run merge: failed to mark ${m.run_id}:${m.archetype_id} as MERGE:`, error);
      } else {
        archetypesMerged++;
        absorbedRefs.add(`${m.run_id}:${m.archetype_id}`);
      }
    }
  }

  const survivors = batch.filter((row) => !absorbedRefs.has(`${row.run_id}:${row.archetype_id}`));
  return { clustersFound, archetypesMerged, survivors };
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// A chapter this large can't be exhaustively compared in one call even at
// this service's raised MAX_GROUP_SIZE (200) -- confirmed directly in
// production: a real chapter reached 407 archetypes in one scope. Rather
// than skip it (the old behavior) or force it through one oversized call
// anyway, this reduces it in rounds: split into MAX_GROUP_SIZE-sized
// sub-batches, detect + apply merges within each independently, then pool
// every sub-batch's own SURVIVORS back together and repeat on that
// smaller pooled set. Reshuffled before every round -- re-splitting
// survivors along the SAME sub-batch boundaries every round would make
// zero progress on a duplicate pair that happens to land in different
// sub-batches (they'd simply never be compared against each other,
// forever); shuffling gives every pair a fresh chance to land in the same
// sub-batch on a later round, the same reasoning the outer iteration
// loop's own repeated passes already rely on for ordinary-sized chapters.
const MAX_REDUCTION_ROUNDS = 5;

async function processChapterGroup(
  chapter: string,
  group: AcceptedRow[],
  provider: LlmProvider,
  supabase: ReturnType<typeof getSupabaseClient>
): Promise<{ clustersFound: number; archetypesMerged: number }> {
  let current = group;
  let totalClusters = 0;
  let totalMerged = 0;

  let round = 0;
  while (current.length > MAX_GROUP_SIZE && round < MAX_REDUCTION_ROUNDS) {
    round++;
    const shuffled = shuffle(current);
    const subBatches: AcceptedRow[][] = [];
    for (let i = 0; i < shuffled.length; i += MAX_GROUP_SIZE) subBatches.push(shuffled.slice(i, i + MAX_GROUP_SIZE));

    console.log(
      `Cross-run merge: chapter "${chapter}" has ${current.length} archetype(s) -- reduction round ${round}/${MAX_REDUCTION_ROUNDS}, ` +
        `${subBatches.length} sub-batch(es) of up to ${MAX_GROUP_SIZE}.`
    );

    const survivorsThisRound: AcceptedRow[] = [];
    for (const subBatch of subBatches) {
      const { clustersFound, archetypesMerged, survivors } = await processBatch(chapter, subBatch, provider, supabase);
      totalClusters += clustersFound;
      totalMerged += archetypesMerged;
      survivorsThisRound.push(...survivors);
    }
    current = survivorsThisRound;
  }

  if (current.length > MAX_GROUP_SIZE) {
    console.warn(
      `Cross-run merge: chapter "${chapter}" still has ${current.length} archetype(s) after ${MAX_REDUCTION_ROUNDS} reduction ` +
        "round(s) -- stopping here for this chapter this pass; a further top-level iteration will pick up where this left off."
    );
    return { clustersFound: totalClusters, archetypesMerged: totalMerged };
  }

  if (current.length > 1) {
    const { clustersFound, archetypesMerged } = await processBatch(chapter, current, provider, supabase);
    totalClusters += clustersFound;
    totalMerged += archetypesMerged;
  }

  return { clustersFound: totalClusters, archetypesMerged: totalMerged };
}

type CrossRunMergePassResult = { chapterGroupsChecked: number; clustersFound: number; archetypesMerged: number };

async function runCrossRunMergeOnePass(params: {
  boardName: string;
  gradeName: string;
  subjectName: string;
}): Promise<CrossRunMergePassResult> {
  const supabase = getSupabaseClient();
  const rows = await loadAcceptedWithChapter(params);
  const groups = groupByChapterCrossRun(rows);
  const provider = getActiveLlmProvider();

  const result: CrossRunMergePassResult = { chapterGroupsChecked: 0, clustersFound: 0, archetypesMerged: 0 };

  console.log(
    `Cross-run merge: checking ${groups.size} chapter group(s) with cross-run archetypes for ` +
      `${params.subjectName} (${params.boardName}, grade ${params.gradeName})...`
  );

  for (const [chapter, group] of groups) {
    result.chapterGroupsChecked++;
    const { clustersFound, archetypesMerged } = await processChapterGroup(chapter, group, provider, supabase);
    result.clustersFound += clustersFound;
    result.archetypesMerged += archetypesMerged;
  }

  // No "done" log here -- the caller (runCrossRunMerge's own iteration
  // loop) logs each pass's result itself, immediately after this returns,
  // and logs the final across-all-iterations summary once the loop ends.
  // A second log line here would just repeat the same numbers under a
  // different, more confusing "done" wording.

  return result;
}
