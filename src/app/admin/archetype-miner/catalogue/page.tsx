import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ArchetypeRow, ArchetypeStatus, CriticDecision, EducationContext } from "@/lib/archetypeMinerTypes";

const DECISION_COLOR: Record<string, string> = {
  KEEP: "bg-green-100 text-green-700",
  ADD: "bg-green-100 text-green-700",
  REVISE: "bg-blue-100 text-blue-700",
  MERGE: "bg-purple-100 text-purple-700",
  SPLIT: "bg-purple-100 text-purple-700",
  REMOVE: "bg-foreground/10 text-foreground/60",
  REVIEW: "bg-yellow-100 text-yellow-700",
};

// Archetypes actually accepted into their own catalogue -- same
// eligibility Stage 4 family mining already uses (see server.ts's
// POST /v1/archetype-families/mine): reviewed/final status, and a
// critic_decision that means "this archetype stands." MERGE/REMOVE
// archetypes are gone in all but name; REVIEW ones haven't been settled.
// "Show everything instead" below (?all=1) bypasses this for anyone who
// wants to see the raw candidate/REVIEW/MERGE state too.
const ACCEPTED_STATUSES: ArchetypeStatus[] = ["reviewed", "final"];
const ACCEPTED_DECISIONS: CriticDecision[] = ["KEEP", "REVISE", "ADD"];

export default async function ArchetypeCatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ board?: string; grade?: string; all?: string }>;
}) {
  await requireAdminPage("archetype_miner");
  const { board, grade, all } = await searchParams;
  const showAll = all === "1";
  const admin = createAdminClient();

  // A separate, unfiltered fetch just to populate the Board/Grade filter
  // dropdowns with values that actually occur in the data -- always scoped
  // to the accepted set regardless of showAll, so the filter options
  // themselves don't shift depending on that toggle.
  const { data: filterRows } = await admin
    .from("archetypes")
    .select("education_context")
    .in("status", ACCEPTED_STATUSES)
    .in("critic_decision", ACCEPTED_DECISIONS);

  const boards = Array.from(
    new Set((filterRows ?? []).map((r) => (r.education_context as EducationContext).curriculum_source.name))
  ).sort();
  const grades = Array.from(
    new Set((filterRows ?? []).map((r) => (r.education_context as EducationContext).grade_or_year))
  ).sort();

  let query = admin.from("archetypes").select("*").order("created_at", { ascending: true });
  if (!showAll) query = query.in("status", ACCEPTED_STATUSES).in("critic_decision", ACCEPTED_DECISIONS);
  if (board) query = query.eq("education_context->curriculum_source->>name", board);
  if (grade) query = query.eq("education_context->>grade_or_year", grade);

  const { data } = await query;
  const rows = (data ?? []) as ArchetypeRow[];

  // board -> grade -> subject -> rows, in that order -- the request this
  // page exists for ("based on board and grade"), with subject as a
  // secondary grouping so a board+grade spanning multiple subjects
  // doesn't render as one long undifferentiated list.
  const grouped = new Map<string, Map<string, Map<string, ArchetypeRow[]>>>();
  for (const row of rows) {
    const ctx = row.education_context;
    const boardKey = ctx.curriculum_source.name;
    const gradeKey = ctx.grade_or_year;
    const subjectKey = ctx.subject_or_course;
    if (!grouped.has(boardKey)) grouped.set(boardKey, new Map());
    const byGrade = grouped.get(boardKey) as Map<string, Map<string, ArchetypeRow[]>>;
    if (!byGrade.has(gradeKey)) byGrade.set(gradeKey, new Map());
    const bySubject = byGrade.get(gradeKey) as Map<string, ArchetypeRow[]>;
    if (!bySubject.has(subjectKey)) bySubject.set(subjectKey, []);
    (bySubject.get(subjectKey) as ArchetypeRow[]).push(row);
  }

  return (
    <div>
      <Link href="/admin/archetype-miner" className="text-sm text-brand hover:underline">
        ← Archetype Miner
      </Link>

      <h1 className="mt-4 text-xl font-semibold">Archetype catalogue</h1>
      <p className="mt-1 max-w-3xl text-sm text-foreground/60">
        Every mined archetype accumulated across ALL pipeline runs, grouped by board and grade/year
        (and by subject within each) -- not scoped to any one run. By default this shows only
        archetypes actually accepted into their own catalogue (status reviewed/final, decision
        KEEP/REVISE/ADD, the same eligibility{" "}
        <Link href="/admin/archetype-miner/families" className="text-brand hover:underline">
          Archetype families
        </Link>{" "}
        mining uses) -- check &quot;Show everything&quot; below to also see candidate/REVIEW/MERGE/
        REMOVE state.
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
        <label className="flex items-center gap-1.5 pb-2 text-xs text-foreground/60">
          <input type="checkbox" name="all" value="1" defaultChecked={showAll} className="h-4 w-4" />
          Show everything (including candidate/REVIEW/MERGE/REMOVE)
        </label>
        <button className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-dark">
          Filter
        </button>
        {(board || grade || showAll) && (
          <Link href="/admin/archetype-miner/catalogue" className="pb-2 text-xs text-brand hover:underline">
            Clear filters
          </Link>
        )}
      </form>

      <p className="mt-4 text-xs text-foreground/40">{rows.length} archetype(s) shown.</p>

      <div className="mt-4 space-y-8">
        {Array.from(grouped.entries()).map(([boardName, byGrade]) => (
          <div key={boardName}>
            <h2 className="text-lg font-semibold">{boardName}</h2>
            <div className="mt-3 space-y-6 border-l-2 border-border pl-4">
              {Array.from(byGrade.entries()).map(([gradeName, bySubject]) => (
                <div key={gradeName}>
                  <h3 className="text-sm font-semibold text-foreground/80">Grade / year {gradeName}</h3>
                  <div className="mt-2 space-y-4">
                    {Array.from(bySubject.entries()).map(([subjectName, subjectRows]) => (
                      <div key={subjectName} className="rounded-xl border border-border bg-surface">
                        <h4 className="border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-wide text-foreground/50">
                          {subjectName} ({subjectRows.length})
                        </h4>
                        <div className="divide-y divide-border">
                          {subjectRows.map((row) => {
                            const a = row.archetype;
                            // archetype_id alone can repeat across different runs (each run's
                            // own id-scoping is per-run, not global -- see
                            // 0041_archetype_miner_run_scoped_ids.sql), and this list spans
                            // every run, so the key needs both.
                            return (
                              <div key={`${row.run_id}-${row.archetype_id}`} className="p-4">
                                <div className="flex flex-wrap items-center gap-2">
                                  <h5 className="font-medium">{a.name}</h5>
                                  <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-xs">{row.status}</span>
                                  {row.critic_decision && (
                                    <span
                                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${DECISION_COLOR[row.critic_decision] ?? "bg-foreground/10 text-foreground/60"}`}
                                    >
                                      {row.critic_decision}
                                    </span>
                                  )}
                                  <span className="text-xs text-foreground/40">
                                    confidence {a.mining_confidence?.toFixed(2)}
                                  </span>
                                </div>
                                <p className="mt-1 text-sm text-foreground/70">{a.learning_objective}</p>
                                <p className="mt-1 text-xs text-foreground/50">{a.invariant_reasoning_structure}</p>
                                {a.variations.length > 0 && (
                                  <ul className="mt-2 flex flex-wrap gap-1.5">
                                    {a.variations.map((v) => (
                                      <li
                                        key={v.variation_id}
                                        className="rounded-full bg-brand/10 px-2 py-0.5 text-xs text-brand"
                                        title={v.variation_type}
                                      >
                                        {v.description}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                                <p className="mt-2 text-xs text-foreground/40">
                                  {a.stats.question_count} question(s) · {a.supporting_question_ids.length} supporting
                                  id(s)
                                  {!a.generator_usable && " · not yet generator-usable"} ·{" "}
                                  <Link href={`/admin/archetype-miner/${row.run_id}`} className="text-brand hover:underline">
                                    from run {row.run_id.slice(0, 8)}
                                  </Link>
                                </p>
                                {a.critic_rationale && (
                                  <p className="mt-1 text-xs text-foreground/50">
                                    <span className="font-medium">Critic:</span> {a.critic_rationale}
                                  </p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="rounded-xl border border-border bg-surface p-8 text-center text-sm text-foreground/50">
            No archetypes match this filter yet.
          </p>
        )}
      </div>
    </div>
  );
}
