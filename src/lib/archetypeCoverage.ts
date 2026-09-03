import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ArchetypeRow, ArchetypeStatus, CriticDecision, EducationContext } from "@/lib/archetypeMinerTypes";

// Shared by the admin coverage page (/admin/archetype-miner/coverage) and
// the student-facing chapter-progress lookup (/api/topics/archetype-progress)
// -- both need the exact same "which chapter/topic did this archetype
// appear under" derivation, and nothing else should reimplement it
// separately (see resolveChapterTopic's own comment for why this is a
// derivation at all, not a stored field).

export const ACCEPTED_STATUSES: ArchetypeStatus[] = ["reviewed", "final"];
export const ACCEPTED_DECISIONS: CriticDecision[] = ["KEEP", "REVISE", "ADD"];

export const UNKNOWN_CHAPTER = "(chapter not resolved)";
export const UNKNOWN_TOPIC = "(topic not resolved)";

export type ArchetypeWithChapterTopic = ArchetypeRow & { resolvedChapter: string; resolvedTopic: string };

type SignatureRow = { run_id: string; question_id: string; signature: { curriculum?: { chapter?: string; topic?: string } } };

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

// Archetype itself doesn't carry a chapter/topic field -- Stage 2 mines
// within an education_context scope, not a chapter one, so a cluster's
// own member questions can (rarely) span more than one chapter/topic
// within the same concept. Chapter/topic live on the per-QUESTION
// signature instead (Stage 1's own curriculum.chapter/topic, stored in
// archetype_question_signatures), so this derives each archetype's
// chapter/topic AT READ TIME from its supporting questions' own
// signatures -- the most common (chapter, topic) pair among them -- which
// also means this works retroactively for every archetype already mined,
// not just runs submitted after this existed.
export async function getArchetypesWithChapterTopic(
  admin: SupabaseClient,
  filter: { board?: string; grade?: string; subject?: string; showAll?: boolean }
): Promise<ArchetypeWithChapterTopic[]> {
  let query = admin.from("archetypes").select("*").order("created_at", { ascending: true });
  if (!filter.showAll) query = query.in("status", ACCEPTED_STATUSES).in("critic_decision", ACCEPTED_DECISIONS);
  if (filter.board) query = query.eq("education_context->curriculum_source->>name", filter.board);
  if (filter.grade) query = query.eq("education_context->>grade_or_year", filter.grade);
  if (filter.subject) query = query.eq("education_context->>subject_or_course", filter.subject);

  const { data } = await query;
  const rows = (data ?? []) as ArchetypeRow[];
  if (rows.length === 0) return [];

  // Bulk-fetch every signature for every run these archetypes came from --
  // question_id is only unique WITHIN a run (see
  // 0041_archetype_miner_run_scoped_ids.sql), so the lookup map below is
  // keyed by "run_id:question_id", not question_id alone. Pulls in some
  // signatures the current filter doesn't strictly need (every question
  // in each run, not just the ones referenced by these specific
  // archetypes) -- simpler than a compound-tuple filter, and cheap at
  // this app's actual scale.
  const runIds = Array.from(new Set(rows.map((r) => r.run_id)));
  const chapterByQuestion = new Map<string, { chapter: string; topic: string }>();
  const { data: signatureRows } = await admin
    .from("archetype_question_signatures")
    .select("run_id, question_id, signature")
    .in("run_id", runIds);
  for (const s of (signatureRows ?? []) as SignatureRow[]) {
    const curriculum = s.signature?.curriculum;
    chapterByQuestion.set(`${s.run_id}:${s.question_id}`, {
      chapter: curriculum?.chapter?.trim() || UNKNOWN_CHAPTER,
      topic: curriculum?.topic?.trim() || UNKNOWN_TOPIC,
    });
  }

  return rows.map((row) => {
    const resolved = row.archetype.supporting_question_ids
      .map((qid) => chapterByQuestion.get(`${row.run_id}:${qid}`))
      .filter((v): v is { chapter: string; topic: string } => Boolean(v));
    const resolvedChapter = mostCommon(resolved.map((r) => r.chapter)) ?? UNKNOWN_CHAPTER;
    const topicsWithinChapter = resolved.filter((r) => r.chapter === resolvedChapter).map((r) => r.topic);
    const resolvedTopic = mostCommon(topicsWithinChapter) ?? UNKNOWN_TOPIC;
    return { ...row, resolvedChapter, resolvedTopic };
  });
}

// Distinct board/grade/subject values within the eligible set, for filter
// dropdowns -- a separate, unfiltered fetch since narrowing by one of
// these shouldn't shrink the OTHER dropdowns' own option lists.
export async function getArchetypeFilterOptions(admin: SupabaseClient): Promise<{ boards: string[]; grades: string[]; subjects: string[] }> {
  const { data } = await admin
    .from("archetypes")
    .select("education_context")
    .in("status", ACCEPTED_STATUSES)
    .in("critic_decision", ACCEPTED_DECISIONS);

  const distinct = (pick: (ctx: EducationContext) => string) =>
    Array.from(new Set((data ?? []).map((r) => pick(r.education_context as EducationContext)))).sort();

  return {
    boards: distinct((c) => c.curriculum_source.name),
    grades: distinct((c) => c.grade_or_year),
    subjects: distinct((c) => c.subject_or_course),
  };
}
