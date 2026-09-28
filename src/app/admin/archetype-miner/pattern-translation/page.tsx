import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getArchetypeFilterOptions } from "@/lib/archetypeCoverage";
import { previewPatternTranslation } from "@/lib/archetypeMinerClient";
import { runPatternTranslationAction } from "../actions";
import { AutoSubmitSelect } from "../auto-submit-select";

// See the service's own patternTranslation.ts for what this catches: a
// mined pattern's own student-facing name (the "Practice a specific
// pattern" pill text) and plain-language student_explanation -- Stage
// 2's own output, a completely different field from curriculum.chapter/
// topic -- still in English even though that pattern's supporting
// questions' curriculum.chapter is already reconciled to the real study
// medium's script (via Curriculum reconciliation) or mined correctly to
// begin with. Confirmed directly in production: a West Bengal Board
// Grade 10 Life Science pattern's own name stayed in English under an
// already-Bengali chapter. Same select-then-preview-then-run shape as
// Topic translation, for the same reason -- an LLM-driven rewrite of
// student-facing text is a deliberate, human-triggered action per scope.
export default async function PatternTranslationPage({
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
      ? previewPatternTranslation({ boardName: board as string, gradeName: grade as string, subjectName: subject as string }).catch(() => null)
      : Promise.resolve(null),
  ]);

  return (
    <div>
      <Link href="/admin/archetype-miner" className="text-sm text-brand hover:underline">
        ← Archetype Miner
      </Link>

      <h1 className="mt-4 text-xl font-semibold">Pattern translation</h1>
      <p className="mt-1 max-w-3xl text-sm text-foreground/75">
        Stage 2 (the Miner) names each mined pattern and writes its plain-language student
        explanation -- shown directly to students as the &quot;Practice a specific pattern&quot;
        pill text and its refresher panel -- in whatever language it defaults to, a completely
        different field from curriculum.chapter/topic. This finds every mined pattern whose name or
        explanation is still in English while its own supporting questions&apos; chapter is already
        in a different, real script, and uses an LLM to translate name/explanation into that same
        script. Everything else about the pattern (its supporting questions, chapter, stats) is left
        exactly as it already was.
      </p>

      <form method="get" className="mt-4 flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1 text-xs text-foreground/75">
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
        <label className="flex flex-col gap-1 text-xs text-foreground/75">
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
        <label className="flex flex-col gap-1 text-xs text-foreground/75">
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
          Pick a board, grade, and subject above to see whether this scope has any untranslated
          pattern names or explanations.
        </p>
      )}

      {scopeChosen && !preview && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          Could not reach the archetype-miner service to preview this scope -- check its health and try again.
        </p>
      )}

      {scopeChosen && preview && preview.translatablePatterns === 0 && (
        <p className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800">
          Every mined pattern in this scope already matches its own chapter&apos;s script (or has no
          real reconciled chapter yet to anchor a translation to) -- nothing to translate here.
        </p>
      )}

      {scopeChosen && preview && preview.translatablePatterns > 0 && (
        <form
          action={runPatternTranslationAction}
          className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-purple-200 bg-purple-50 px-4 py-2 text-sm text-purple-800"
        >
          <input type="hidden" name="boardName" value={board} />
          <input type="hidden" name="gradeName" value={grade} />
          <input type="hidden" name="subjectName" value={subject} />
          <p>
            {preview.translatablePatterns} pattern(s) in this scope have a name or explanation still
            in English under an already-translated chapter -- worth translating.
            {preview.inProgress && (
              <span className="ml-1 font-medium">
                A pass is already running — check `docker logs` for its own &quot;Pattern translation: done.&quot; line, then reload this page.
              </span>
            )}
          </p>
          <button
            type="submit"
            disabled={preview.inProgress}
            className="shrink-0 rounded-lg bg-purple-600 px-3 py-1.5 font-medium text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {preview.inProgress ? "Translating…" : "Translate now"}
          </button>
        </form>
      )}
    </div>
  );
}
