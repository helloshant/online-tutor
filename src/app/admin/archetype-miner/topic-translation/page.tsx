import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getArchetypeFilterOptions } from "@/lib/archetypeCoverage";
import { previewTopicTranslation } from "@/lib/archetypeMinerClient";
import { runTopicTranslationAction } from "../actions";
import { AutoSubmitSelect } from "../auto-submit-select";

// See the service's own topicTranslation.ts for what this catches: a run
// mined before this pipeline's own LANGUAGE instruction was added still
// has curriculum.topic in English, even for a question whose
// curriculum.chapter is already in the real study-medium script (via
// Curriculum reconciliation, or from mining after the LANGUAGE fix).
// Confirmed directly in production: the student-facing sub-topic picker
// (built from curriculum.topic) showed English pills under a Bengali
// chapter for West Bengal Board content. Unlike Curriculum reconciliation,
// there's no real syllabus_topics list to match a fine-grained
// per-question topic against -- this is a straight LLM translation pass,
// using each topic's own already-correct chapter as translation context.
// Same select-then-preview-then-run shape as Curriculum reconciliation,
// for the same reason -- an LLM-driven rewrite of student-facing text is
// a deliberate, human-triggered action per scope, never a blind sweep.
export default async function TopicTranslationPage({
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
      ? previewTopicTranslation({ boardName: board as string, gradeName: grade as string, subjectName: subject as string }).catch(() => null)
      : Promise.resolve(null),
  ]);

  return (
    <div>
      <Link href="/admin/archetype-miner" className="text-sm text-brand hover:underline">
        ← Archetype Miner
      </Link>

      <h1 className="mt-4 text-xl font-semibold">Topic translation</h1>
      <p className="mt-1 max-w-3xl text-sm text-foreground/75">
        Stage 1 classifies each question&apos;s fine-grained curriculum.topic (what drives the
        student-facing &quot;pick a sub-topic&quot; picker) in whatever language it defaults to --
        runs mined before this pipeline started matching the study medium&apos;s own script left
        curriculum.topic in English even when curriculum.chapter for the same question is already
        in the real medium&apos;s script (via Curriculum reconciliation, or from mining). This finds
        every mined topic value still in English whose own chapter is already in a different
        script, and uses an LLM to translate the topic into that same script -- using the chapter as
        context for which script and subject vocabulary to use. Only curriculum.topic is touched;
        curriculum.chapter is left exactly as it already was.
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
          topic values.
        </p>
      )}

      {scopeChosen && !preview && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          Could not reach the archetype-miner service to preview this scope -- check its health and try again.
        </p>
      )}

      {scopeChosen && preview && preview.translatableTopics === 0 && (
        <p className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800">
          Every mined topic value in this scope already matches its own chapter&apos;s script (or
          this scope&apos;s chapters are still in English themselves) -- nothing to translate here.
        </p>
      )}

      {scopeChosen && preview && preview.translatableTopics > 0 && (
        <form
          action={runTopicTranslationAction}
          className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-purple-200 bg-purple-50 px-4 py-2 text-sm text-purple-800"
        >
          <input type="hidden" name="boardName" value={board} />
          <input type="hidden" name="gradeName" value={grade} />
          <input type="hidden" name="subjectName" value={subject} />
          <p>
            {preview.translatableTopics} topic value(s) ({preview.affectedQuestions} question(s) total) in
            this scope are still in English under an already-translated chapter -- worth translating.
            {preview.inProgress && (
              <span className="ml-1 font-medium">
                A pass is already running — check `docker logs` for its own &quot;Topic translation: done.&quot; line, then reload this page.
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
