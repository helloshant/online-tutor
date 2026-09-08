import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getArchetypeFilterOptions } from "@/lib/archetypeCoverage";
import { previewCrossRunMerge } from "@/lib/archetypeMinerClient";
import { runCrossRunMergeAction } from "../actions";

// See the service's own crossRunMerge.ts for what this catches: the SAME
// reasoning pattern mined independently under different wording across
// separate runs -- Stage 3's own MERGE detection only ever compares
// candidates within one run's own batch, so it was never positioned to
// catch this. Always scoped to one explicit board/grade/subject (same
// select-then-preview-then-run shape the coverage page and family mining
// already use) -- a false merge is a real, silent taxonomy error, so this
// is a deliberate, human-triggered action per scope, never a blind
// whole-catalogue sweep.
export default async function CrossRunMergePage({
  searchParams,
}: {
  searchParams: Promise<{ board?: string; grade?: string; subject?: string }>;
}) {
  await requireAdminPage("archetype_miner");
  const { board, grade, subject } = await searchParams;
  const admin = createAdminClient();
  const scopeChosen = Boolean(board && grade && subject);

  const [{ boards, grades, subjects }, preview] = await Promise.all([
    getArchetypeFilterOptions(admin, { board, grade }),
    // Best-effort, same "never break the page over this" posture every
    // other archetype-miner-service preview already uses -- a failure
    // just hides the count/button below rather than a broken page.
    scopeChosen
      ? previewCrossRunMerge({ boardName: board as string, gradeName: grade as string, subjectName: subject as string }).catch(() => null)
      : Promise.resolve(null),
  ]);

  return (
    <div>
      <Link href="/admin/archetype-miner" className="text-sm text-brand hover:underline">
        ← Archetype Miner
      </Link>

      <h1 className="mt-4 text-xl font-semibold">Cross-run duplicate merge</h1>
      <p className="mt-1 max-w-3xl text-sm text-foreground/60">
        Stage 3&apos;s own duplicate detection only ever compares archetypes mined within ONE run&apos;s
        own batch -- it has no visibility into any other run at all. The same reasoning pattern mined
        across several separate papers/runs for the same chapter shows up as several differently-worded
        archetypes with no MERGE ever proposed between them (confirmed directly: one pattern existed as
        10 separate copies across 10 runs). This detects and merges those -- real semantic judgment, an
        LLM call per affected chapter, so it&apos;s scoped to one board/grade/subject at a time and run
        deliberately, not automatically.
      </p>

      <form method="get" className="mt-4 flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1 text-xs text-foreground/60">
          Board
          <select
            name="board"
            defaultValue={board ?? ""}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            <option value="">Select a board</option>
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
            <option value="">Select a grade</option>
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
            <option value="">Select a subject</option>
            {subjects.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-dark">
          Check
        </button>
      </form>

      {!scopeChosen && (
        <p className="mt-4 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-2 text-sm text-yellow-800">
          Pick a board, grade, and subject above to see whether this scope has any cross-run duplicates.
        </p>
      )}

      {scopeChosen && !preview && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          Could not reach the archetype-miner service to preview this scope -- check its health and try again.
        </p>
      )}

      {scopeChosen && preview && preview.archetypesInvolved === 0 && (
        <p className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800">
          No chapters in this scope have archetypes from more than one run -- nothing to check for cross-run
          duplicates here.
        </p>
      )}

      {scopeChosen && preview && preview.archetypesInvolved > 0 && (
        <form
          action={runCrossRunMergeAction}
          className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-purple-200 bg-purple-50 px-4 py-2 text-sm text-purple-800"
        >
          <input type="hidden" name="boardName" value={board} />
          <input type="hidden" name="gradeName" value={grade} />
          <input type="hidden" name="subjectName" value={subject} />
          <p>
            {preview.chapterGroups} chapter(s) in this scope have archetypes from more than one run
            ({preview.archetypesInvolved} archetype(s) total) -- worth checking for cross-run duplicates.
            {preview.inProgress && (
              <span className="ml-1 font-medium">
                A pass is already running for some scope — check `docker logs` for its own &quot;Cross-run merge: done.&quot; line, then reload this page.
              </span>
            )}
          </p>
          <button
            type="submit"
            disabled={preview.inProgress}
            className="shrink-0 rounded-lg bg-purple-600 px-3 py-1.5 font-medium text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {preview.inProgress ? "Merge running…" : "Run merge now"}
          </button>
        </form>
      )}
    </div>
  );
}
