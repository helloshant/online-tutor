import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getArchetypeFilterOptions } from "@/lib/archetypeCoverage";
import { previewOffScopeContentScan } from "@/lib/archetypeMinerClient";
import { runOffScopeContentScanAction } from "../actions";
import { AutoSubmitSelect } from "../auto-submit-select";

// Mirrors the service's own isLanguageArtsSubject() (offScopeContentScan.ts)
// -- reimplemented here, same as every other small helper this file's
// siblings already duplicate rather than share, purely so the page can show
// its OWN explanation instead of reusing the generic "already checked"
// copy, which would be misleading for a scope this scan never actually
// looks at (see that function's own comment for why).
const LANGUAGE_ARTS_SUBJECTS = new Set(["english", "hindi", "bengali"]);
function isLanguageArtsSubject(subjectName: string): boolean {
  return LANGUAGE_ARTS_SUBJECTS.has(subjectName.trim().toLowerCase());
}

// See the service's own offScopeContentScan.ts for what this catches:
// content that reached the catalogue BEFORE pipelineRunner.ts started
// checking for this at mining time (see OFF_SCOPE_CONTENT_FLAG) -- a
// question that's actually a different subject entirely, or actually a
// different grade's own syllabus content, mined under the wrong
// education_context. Confirmed live in production and corrected manually
// once already: a "Biology" archetype whose only supporting question was
// an English poem's own MCQ, and a Grade-12-tagged archetype whose only
// supporting question was actually Grade 11 content. Neither was found by
// any automated process -- both turned up by accident while investigating
// something else, which is why this exists as its own sweep rather than
// trusting that those two were the only cases anywhere in the catalogue.
// Always scoped to one explicit board/grade/subject (same select-then-
// preview-then-run shape cross-run-merge/curriculum-reconciliation
// already use) -- a false positive here would wrongly discard real
// content and remove a legitimate archetype, so this is a deliberate,
// human-triggered sweep, never a blind whole-catalogue pass.
export default async function OffScopeContentScanPage({
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
      ? previewOffScopeContentScan({ boardName: board as string, gradeName: grade as string, subjectName: subject as string }).catch(() => null)
      : Promise.resolve(null),
  ]);

  return (
    <div>
      <Link href="/admin/archetype-miner" className="text-sm text-brand hover:underline">
        ← Archetype Miner
      </Link>

      <h1 className="mt-4 text-xl font-semibold">Off-scope content scan</h1>
      <p className="mt-1 max-w-3xl text-sm text-foreground/60">
        Checks every already-mined question in one board/grade/subject scope against its own real
        content -- flagging anything that&apos;s actually a different subject entirely (e.g. an
        English question mixed into a Biology paper) or actually a different grade&apos;s own
        syllabus content, using real semantic judgment (an LLM call) rather than just a chapter-name
        check. A flagged question is marked, queued for human review, and any currently-visible
        archetype built ENTIRELY from it is removed automatically; an archetype with other,
        unflagged supporting questions too is left for a human to decide on instead of guessed at.
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
          Pick a board, grade, and subject above to see how many questions this scope has to scan.
        </p>
      )}

      {scopeChosen && !preview && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          Could not reach the archetype-miner service to preview this scope -- check its health and try again.
        </p>
      )}

      {scopeChosen && subject && isLanguageArtsSubject(subject) && (
        <p className="mt-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800">
          {subject} is a language-arts subject, so this scan doesn&apos;t run against it at all --
          reading-comprehension passages are deliberately drawn from arbitrary real-world topics to
          test reading skill, not subject knowledge, so a &quot;does this content&apos;s topic belong
          to this subject&quot; check would flag most of the subject by design. Confirmed live: a
          single run against English (CBSE, grade 10) flagged 50 of ~800 questions this way, every
          one a false positive.
        </p>
      )}

      {scopeChosen && preview && preview.flaggedQuestions > 0 && (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          {preview.flaggedQuestions} question(s) in this scope are already flagged as off-scope and
          waiting on a human decision -- open the run(s) they belong to from the{" "}
          <Link href="/admin/archetype-miner" className="underline">
            Archetype Miner
          </Link>{" "}
          page to resolve them.
        </p>
      )}

      {scopeChosen && subject && !isLanguageArtsSubject(subject) && preview && preview.candidateQuestions === 0 && (
        <p className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800">
          {preview.flaggedQuestions > 0
            ? "Every other question in this scope has already been checked and found clean."
            : "Nothing left to scan in this scope -- every question here has already been checked (or flagged) by a previous pass."}
        </p>
      )}

      {scopeChosen && preview && preview.candidateQuestions > 0 && (
        <form
          action={runOffScopeContentScanAction}
          className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-purple-200 bg-purple-50 px-4 py-2 text-sm text-purple-800"
        >
          <input type="hidden" name="boardName" value={board} />
          <input type="hidden" name="gradeName" value={grade} />
          <input type="hidden" name="subjectName" value={subject} />
          <p>
            {preview.candidateQuestions} question(s) in this scope haven&apos;t been checked yet --
            each one costs one small LLM call per batch of ~40, so this can take a while for a large
            scope.
            {preview.inProgress && (
              <span className="ml-1 font-medium">
                A pass is already running — check `docker logs` for its own &quot;Off-scope content scan: done.&quot; line, then reload this page.
              </span>
            )}
          </p>
          <button
            type="submit"
            disabled={preview.inProgress}
            className="shrink-0 rounded-lg bg-purple-600 px-3 py-1.5 font-medium text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {preview.inProgress ? "Scanning…" : "Scan now"}
          </button>
        </form>
      )}
    </div>
  );
}
