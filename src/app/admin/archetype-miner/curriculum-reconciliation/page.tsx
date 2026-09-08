import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getArchetypeFilterOptions } from "@/lib/archetypeCoverage";
import { previewCurriculumReconciliation } from "@/lib/archetypeMinerClient";
import { runCurriculumReconciliationAction } from "../actions";
import { AutoSubmitSelect } from "../auto-submit-select";

// See the service's own curriculumReconciliation.ts for what this catches:
// already-mined questions whose curriculum.chapter/topic don't exactly
// match this app's own curated syllabus_topics wording -- confirmed
// directly in production, e.g. "Biotechnology Principles and Processes"
// vs the syllabus's own "Biotechnology: Principles and Processes",
// "Origin of Life and Evolution" vs "Evolution". A mismatch like this
// doesn't error anywhere -- it just silently excludes that question's
// archetype from ever surfacing under its real topic (year-coverage,
// archetype-progress, the pattern picker's own lookup all require an
// EXACT match). Always scoped to one explicit board/grade/subject (same
// select-then-preview-then-run shape cross-run-merge/coverage already
// use) -- a wrong mapping silently reassigns real questions to the wrong
// topic, so this is a deliberate, human-triggered action per scope, never
// a blind whole-catalogue sweep.
export default async function CurriculumReconciliationPage({
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
      ? previewCurriculumReconciliation({ boardName: board as string, gradeName: grade as string, subjectName: subject as string }).catch(
          () => null
        )
      : Promise.resolve(null),
  ]);

  return (
    <div>
      <Link href="/admin/archetype-miner" className="text-sm text-brand hover:underline">
        ← Archetype Miner
      </Link>

      <h1 className="mt-4 text-xl font-semibold">Curriculum chapter/topic reconciliation</h1>
      <p className="mt-1 max-w-3xl text-sm text-foreground/60">
        Stage 1 classifies each question&apos;s chapter/topic from its own judgment whenever no
        taxonomy document anchors it to this app&apos;s own curated syllabus wording -- producing
        text that&apos;s topically right but doesn&apos;t exactly match it (a colon, an extra word, a
        different phrasing). Every place that matches a mined archetype back to a real syllabus
        topic requires an exact string match, so a mismatch like this silently excludes that
        question from ever showing up under its real topic. This finds every already-mined
        chapter/topic pair that doesn&apos;t match the real syllabus for one board/grade/subject, and
        uses real semantic judgment (an LLM call) to remap it onto the correct syllabus entry -- or
        leaves it alone when there&apos;s no confident match.
      </p>

      <form method="get" className="mt-4 flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1 text-xs text-foreground/60">
          Board
          <AutoSubmitSelect
            name="board"
            defaultValue={board ?? ""}
            clearFieldNames={["grade", "subject"]}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            <option value="">Select a board</option>
            {boards.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </AutoSubmitSelect>
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground/60">
          Grade / year
          <AutoSubmitSelect
            name="grade"
            defaultValue={grade ?? ""}
            clearFieldNames={["subject"]}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            <option value="">Select a grade</option>
            {grades.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </AutoSubmitSelect>
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
          Pick a board, grade, and subject above to see whether this scope has any unreconciled
          chapter/topic pairs.
        </p>
      )}

      {scopeChosen && !preview && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          Could not reach the archetype-miner service to preview this scope -- check its health and try again.
        </p>
      )}

      {scopeChosen && preview && preview.syllabusPairsAvailable === 0 && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          No syllabus_topics rows exist for this exact board/grade/subject scope -- there&apos;s
          nothing real to reconcile against here.
        </p>
      )}

      {scopeChosen && preview && preview.syllabusPairsAvailable > 0 && preview.unmatchedPairs === 0 && (
        <p className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800">
          Every mined chapter/topic pair in this scope already matches the real syllabus -- nothing
          to reconcile here.
        </p>
      )}

      {scopeChosen && preview && preview.syllabusPairsAvailable > 0 && preview.unmatchedPairs > 0 && (
        <form
          action={runCurriculumReconciliationAction}
          className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-purple-200 bg-purple-50 px-4 py-2 text-sm text-purple-800"
        >
          <input type="hidden" name="boardName" value={board} />
          <input type="hidden" name="gradeName" value={grade} />
          <input type="hidden" name="subjectName" value={subject} />
          <p>
            {preview.unmatchedPairs} chapter/topic pair(s) ({preview.affectedQuestions} question(s) total) in this
            scope don&apos;t exactly match the real syllabus -- worth checking for a fixable mismatch.
            {preview.inProgress && (
              <span className="ml-1 font-medium">
                A pass is already running — check `docker logs` for its own &quot;Curriculum reconciliation: done.&quot; line, then reload this page.
              </span>
            )}
          </p>
          <button
            type="submit"
            disabled={preview.inProgress}
            className="shrink-0 rounded-lg bg-purple-600 px-3 py-1.5 font-medium text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {preview.inProgress ? "Reconciling…" : "Reconcile now"}
          </button>
        </form>
      )}
    </div>
  );
}
