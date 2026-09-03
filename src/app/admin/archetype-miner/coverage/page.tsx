import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getArchetypeFilterOptions, getArchetypesWithChapterTopic, type ArchetypeWithChapterTopic } from "@/lib/archetypeCoverage";

export default async function ArchetypeCoveragePage({
  searchParams,
}: {
  searchParams: Promise<{ board?: string; grade?: string; subject?: string; all?: string }>;
}) {
  await requireAdminPage("archetype_miner");
  const { board, grade, subject, all } = await searchParams;
  const showAll = all === "1";
  const admin = createAdminClient();

  const [{ boards, grades, subjects }, rows] = await Promise.all([
    getArchetypeFilterOptions(admin),
    getArchetypesWithChapterTopic(admin, { board, grade, subject, showAll }),
  ]);

  // chapter -> topic -> rows.
  const grouped = new Map<string, Map<string, ArchetypeWithChapterTopic[]>>();
  for (const row of rows) {
    if (!grouped.has(row.resolvedChapter)) grouped.set(row.resolvedChapter, new Map());
    const byTopic = grouped.get(row.resolvedChapter) as Map<string, ArchetypeWithChapterTopic[]>;
    if (!byTopic.has(row.resolvedTopic)) byTopic.set(row.resolvedTopic, []);
    (byTopic.get(row.resolvedTopic) as ArchetypeWithChapterTopic[]).push(row);
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
