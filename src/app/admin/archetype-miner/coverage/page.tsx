import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ArchetypeRow, ArchetypeStatus, CriticDecision, EducationContext } from "@/lib/archetypeMinerTypes";

// Same eligibility the main catalogue and family mining already use --
// see catalogue/page.tsx's own comment. "Show everything" (?all=1) bypasses
// it for anyone who wants to see candidate/REVIEW/MERGE state too.
const ACCEPTED_STATUSES: ArchetypeStatus[] = ["reviewed", "final"];
const ACCEPTED_DECISIONS: CriticDecision[] = ["KEEP", "REVISE", "ADD"];

const UNKNOWN_CHAPTER = "(chapter not resolved)";
const UNKNOWN_TOPIC = "(topic not resolved)";

// Archetype itself doesn't carry a chapter/topic field -- Stage 2 mines
// within an education_context scope, not a chapter one, so a cluster's
// own member questions can (rarely) span more than one chapter/topic
// within the same concept. Chapter/topic live on the per-QUESTION
// signature instead (Stage 1's own curriculum.chapter/topic, stored in
// archetype_question_signatures), so this derives each archetype's
// chapter/topic AT READ TIME from its supporting questions' own
// signatures -- the most common (chapter, topic) pair among them -- which
// also means this works retroactively for every archetype already mined,
// not just runs submitted after this page existed.
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

export default async function ArchetypeCoveragePage({
  searchParams,
}: {
  searchParams: Promise<{ board?: string; grade?: string; subject?: string; all?: string }>;
}) {
  await requireAdminPage("archetype_miner");
  const { board, grade, subject, all } = await searchParams;
  const showAll = all === "1";
  const admin = createAdminClient();

  // Unfiltered fetch (within the eligible set) just to populate the
  // filter dropdowns with values that actually occur in the data -- same
  // reasoning as the main catalogue page's own board/grade dropdowns,
  // extended with subject since chapters/topics only make sense scoped to
  // one subject.
  const { data: filterRows } = await admin
    .from("archetypes")
    .select("education_context")
    .in("status", ACCEPTED_STATUSES)
    .in("critic_decision", ACCEPTED_DECISIONS);

  const distinct = (pick: (ctx: EducationContext) => string) =>
    Array.from(new Set((filterRows ?? []).map((r) => pick(r.education_context as EducationContext)))).sort();
  const boards = distinct((c) => c.curriculum_source.name);
  const grades = distinct((c) => c.grade_or_year);
  const subjects = distinct((c) => c.subject_or_course);

  let query = admin.from("archetypes").select("*").order("created_at", { ascending: true });
  if (!showAll) query = query.in("status", ACCEPTED_STATUSES).in("critic_decision", ACCEPTED_DECISIONS);
  if (board) query = query.eq("education_context->curriculum_source->>name", board);
  if (grade) query = query.eq("education_context->>grade_or_year", grade);
  if (subject) query = query.eq("education_context->>subject_or_course", subject);

  const { data } = await query;
  const rows = (data ?? []) as ArchetypeRow[];

  // Bulk-fetch every signature for every run these archetypes came from --
  // question_id is only unique WITHIN a run (see
  // 0041_archetype_miner_run_scoped_ids.sql), so the lookup map below is
  // keyed by "run_id:question_id", not question_id alone. This pulls in
  // some signatures the current filter doesn't strictly need (every
  // question in each run, not just the ones referenced by these specific
  // archetypes) -- simpler than a compound-tuple filter, and cheap at this
  // tool's actual scale (an admin catalogue, not a student-facing query).
  const runIds = Array.from(new Set(rows.map((r) => r.run_id)));
  type SignatureRow = { run_id: string; question_id: string; signature: { curriculum?: { chapter?: string; topic?: string } } };
  const chapterByQuestion = new Map<string, { chapter: string; topic: string }>();
  if (runIds.length > 0) {
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
  }

  // chapter -> topic -> rows, each row annotated with its own resolved
  // (chapter, topic) for rendering.
  type AnnotatedRow = ArchetypeRow & { resolvedChapter: string; resolvedTopic: string };
  const grouped = new Map<string, Map<string, AnnotatedRow[]>>();
  for (const row of rows) {
    const resolved = row.archetype.supporting_question_ids
      .map((qid) => chapterByQuestion.get(`${row.run_id}:${qid}`))
      .filter((v): v is { chapter: string; topic: string } => Boolean(v));
    const resolvedChapter = mostCommon(resolved.map((r) => r.chapter)) ?? UNKNOWN_CHAPTER;
    const topicsWithinChapter = resolved.filter((r) => r.chapter === resolvedChapter).map((r) => r.topic);
    const resolvedTopic = mostCommon(topicsWithinChapter) ?? UNKNOWN_TOPIC;

    if (!grouped.has(resolvedChapter)) grouped.set(resolvedChapter, new Map());
    const byTopic = grouped.get(resolvedChapter) as Map<string, AnnotatedRow[]>;
    if (!byTopic.has(resolvedTopic)) byTopic.set(resolvedTopic, []);
    (byTopic.get(resolvedTopic) as AnnotatedRow[]).push({ ...row, resolvedChapter, resolvedTopic });
  }
  // Chapters sorted by how many archetypes they hold (most-covered first)
  // -- more useful at a glance than alphabetical for a coverage view.
  const chapterEntries = Array.from(grouped.entries()).sort(
    (a, b) => Array.from(b[1].values()).flat().length - Array.from(a[1].values()).flat().length
  );

  const scopeChosen = Boolean(board && grade && subject);

  return (
    <div>
      <Link href="/admin/archetype-miner" className="text-sm text-brand hover:underline">
        ← Archetype Miner
      </Link>

      <h1 className="mt-4 text-xl font-semibold">Chapter / topic coverage</h1>
      <p className="mt-1 max-w-3xl text-sm text-foreground/60">
        Every mined archetype, grouped by the chapter and topic it actually appeared under in the exam --
        derived from its supporting questions&apos; own curriculum classification (the most common chapter/topic
        among them), not a separate field on the archetype itself, so this works for every run already mined,
        not just future ones. Pick a board, grade, and subject to see its chapters.
      </p>

      <form method="get" className="mt-4 flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1 text-xs text-foreground/60">
          Board
          <select
            name="board"
            defaultValue={board ?? ""}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            <option value="">All boards</option>
            {boards.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground/60">
          Grade / year
          <select
            name="grade"
            defaultValue={grade ?? ""}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            <option value="">All grades</option>
            {grades.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground/60">
          Subject
          <select
            name="subject"
            defaultValue={subject ?? ""}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            <option value="">All subjects</option>
            {subjects.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 pb-2 text-xs text-foreground/60">
          <input type="checkbox" name="all" value="1" defaultChecked={showAll} className="h-4 w-4" />
          Show everything (including candidate/REVIEW/MERGE/REMOVE)
        </label>
        <button className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-dark">
          Filter
        </button>
        {(board || grade || subject || showAll) && (
          <Link href="/admin/archetype-miner/coverage" className="pb-2 text-xs text-brand hover:underline">
            Clear filters
          </Link>
        )}
      </form>

      {!scopeChosen && (
        <p className="mt-4 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-2 text-sm text-yellow-800">
          Chapters only make sense within one board + grade + subject -- pick all three above. Showing{" "}
          {rows.length} archetype(s) across whatever&apos;s currently selected in the meantime.
        </p>
      )}

      <p className="mt-4 text-xs text-foreground/40">
        {rows.length} archetype(s) across {chapterEntries.length} chapter(s) shown.
      </p>

      <div className="mt-4 space-y-8">
        {chapterEntries.map(([chapterName, byTopic]) => {
          const chapterCount = Array.from(byTopic.values()).flat().length;
          return (
            <div key={chapterName}>
              <h2 className="text-lg font-semibold">
                {chapterName} <span className="text-sm font-normal text-foreground/40">({chapterCount})</span>
              </h2>
              <div className="mt-3 space-y-4 border-l-2 border-border pl-4">
                {Array.from(byTopic.entries()).map(([topicName, topicRows]) => (
                  <div key={topicName} className="rounded-xl border border-border bg-surface">
                    <h3 className="border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-wide text-foreground/50">
                      {topicName} ({topicRows.length})
                    </h3>
                    <div className="divide-y divide-border">
                      {topicRows.map((row) => {
                        const a = row.archetype;
                        return (
                          <div key={`${row.run_id}-${row.archetype_id}`} className="p-4">
                            <div className="flex flex-wrap items-center gap-2">
                              <h4 className="font-medium">{a.name}</h4>
                              <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-xs">{row.status}</span>
                              {row.critic_decision && (
                                <span className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">
                                  {row.critic_decision}
                                </span>
                              )}
                              <span className="text-xs text-foreground/40">
                                confidence {a.mining_confidence?.toFixed(2)}
                              </span>
                            </div>
                            <p className="mt-1 text-sm text-foreground/70">{a.learning_objective}</p>
                            <p className="mt-1 text-xs text-foreground/50">{a.invariant_reasoning_structure}</p>
                            <p className="mt-2 text-xs text-foreground/40">
                              {a.stats.question_count} question(s) in {a.stats.years_observed.join(", ") || "unknown year(s)"}
                              {!a.generator_usable && " · not yet generator-usable"} ·{" "}
                              <Link href={`/admin/archetype-miner/${row.run_id}`} className="text-brand hover:underline">
                                from run {row.run_id.slice(0, 8)}
                              </Link>
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {chapterEntries.length === 0 && (
          <p className="rounded-xl border border-border bg-surface p-8 text-center text-sm text-foreground/50">
            No archetypes match this filter yet.
          </p>
        )}
      </div>
    </div>
  );
}
