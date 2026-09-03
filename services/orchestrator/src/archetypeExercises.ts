// Looks up mined archetypes for a chapter/topic to ground exercise
// generation in real, proven exam patterns instead of the ungrounded
// "vary difficulty slightly" fallback (see prompts.ts's
// buildExerciseGenerationPrompt). Reads the archetype_* tables directly
// with this service's own Supabase connection -- same "read shared tables
// directly, no extra HTTP hop" pattern the web app's admin catalogue/
// coverage pages already use for this exact data (the archetype-miner
// service itself only exposes submit-run/mine-families, not a read API,
// see its own README section) -- rather than calling that service.
//
// Chapter/topic matching is deliberately soft (trimmed, case-insensitive),
// never exact-only: this service's own syllabus_topics table (curated by
// an admin) and the archetype pipeline's Stage 1 (LLM-derived
// curriculum.chapter/topic during mining, see the coverage page's own
// comment on why this isn't a field on Archetype itself) name chapters
// completely independently, with no cross-reference between the two
// systems today -- there's no guarantee their spellings align exactly
// even when they mean the same chapter. A mismatch (or nothing mined for
// this scope yet, the common case for most chapters right now) just means
// this returns an empty array and generation falls back to the original
// ungrounded prompt -- never an error, never blocks a student's request.
import { getSupabaseClient } from "./supabaseClient.js";
import type { ExerciseArchetype } from "./prompts.js";

const ACCEPTED_STATUSES = ["reviewed", "final"];
const ACCEPTED_DECISIONS = ["KEEP", "REVISE", "ADD"];
// Matches EXERCISE_GENERATION_COUNT in server.ts -- no reason to fetch/
// pass more patterns than the exercise set could ever draw from.
const MAX_ARCHETYPES = 5;

type SignatureRow = { run_id: string; question_id: string; signature: { curriculum?: { chapter?: string; topic?: string } } };

type ArchetypeLookupRow = {
  run_id: string;
  archetype: {
    name: string;
    invariant_reasoning_structure: string;
    variations: { description: string }[];
    supporting_question_ids: string[];
    stats: { difficulty_distribution: { Easy: number; Medium: number; Hard: number } };
  };
};

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

export async function findArchetypesForTopic(params: {
  boardName: string;
  gradeName: string;
  subjectName: string;
  chapter: string;
  topic: string;
}): Promise<ExerciseArchetype[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  const { data: archetypeRows, error } = await supabase
    .from("archetypes")
    .select("run_id, archetype")
    .eq("education_context->curriculum_source->>name", params.boardName)
    .eq("education_context->>grade_or_year", params.gradeName)
    .eq("education_context->>subject_or_course", params.subjectName)
    .in("status", ACCEPTED_STATUSES)
    .in("critic_decision", ACCEPTED_DECISIONS);

  if (error) {
    console.error("Archetype lookup for exercise generation failed (falling back to ungrounded generation):", error);
    return [];
  }
  if (!archetypeRows || archetypeRows.length === 0) return [];

  const rows = archetypeRows as unknown as ArchetypeLookupRow[];
  const runIds = Array.from(new Set(rows.map((r) => r.run_id)));

  const { data: signatureRows, error: sigError } = await supabase
    .from("archetype_question_signatures")
    .select("run_id, question_id, signature")
    .in("run_id", runIds);

  if (sigError) {
    console.error("Signature lookup for exercise generation failed (falling back to ungrounded generation):", sigError);
    return [];
  }

  const chapterByQuestion = new Map<string, { chapter: string; topic: string }>();
  for (const s of (signatureRows ?? []) as SignatureRow[]) {
    const curriculum = s.signature?.curriculum;
    if (!curriculum?.chapter || !curriculum?.topic) continue;
    chapterByQuestion.set(`${s.run_id}:${s.question_id}`, { chapter: curriculum.chapter, topic: curriculum.topic });
  }

  const targetChapter = normalize(params.chapter);
  const targetTopic = normalize(params.topic);

  const matches: ExerciseArchetype[] = [];
  for (const row of rows) {
    const resolved = row.archetype.supporting_question_ids
      .map((qid) => chapterByQuestion.get(`${row.run_id}:${qid}`))
      .filter((v): v is { chapter: string; topic: string } => Boolean(v));
    const isMatch = resolved.some((r) => normalize(r.chapter) === targetChapter && normalize(r.topic) === targetTopic);
    if (!isMatch) continue;

    const dist = row.archetype.stats?.difficulty_distribution;
    const difficulty = dist
      ? ((Object.entries(dist).sort((a, b) => b[1] - a[1])[0]?.[0] as "Easy" | "Medium" | "Hard" | undefined) ?? null)
      : null;

    matches.push({
      name: row.archetype.name,
      invariantReasoningStructure: row.archetype.invariant_reasoning_structure,
      variationDescriptions: (row.archetype.variations ?? []).map((v) => v.description),
      difficulty,
    });

    if (matches.length >= MAX_ARCHETYPES) break;
  }

  return matches;
}
