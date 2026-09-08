import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getArchetypeMinerHealth, previewStage3Recovery, previewStudentExplanationBackfill } from "@/lib/archetypeMinerClient";
import { SubmitRunForm } from "./submit-run-form";
import { recoverStage3Action, backfillStudentExplanationAction } from "./actions";
import type { PipelineRunRow } from "@/lib/archetypeMinerTypes";

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  segmenting: "Segmenting",
  analyzing: "Analyzing",
  embedding: "Embedding",
  clustering: "Clustering",
  mining: "Mining",
  critiquing: "Critiquing",
  completed: "Completed",
  failed: "Failed",
};

export default async function ArchetypeMinerPage() {
  await requireAdminPage("archetype_miner");
  const admin = createAdminClient();

  const [{ data: runs }, { count: pendingReviewCount }, health, stage3RecoveryPreview, studentExplanationPreview] = await Promise.all([
    admin.from("archetype_pipeline_runs").select("*").order("created_at", { ascending: false }).limit(50),
    admin.from("archetype_review_queue").select("*", { count: "exact", head: true }).eq("status", "pending"),
    getArchetypeMinerHealth(),
    // Best-effort, same "never break the page over this" posture as
    // getArchetypeMinerHealth above -- a preview failure just hides the
    // recovery banner below rather than a broken page load.
    previewStage3Recovery().catch(() => null),
    previewStudentExplanationBackfill().catch(() => null),
  ]);

  const rows = (runs ?? []) as PipelineRunRow[];

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Question Archetype Miner</h1>
          <p className="mt-1 text-sm text-foreground/60">
            Mines a reusable archetype taxonomy from a historical question corpus (Segmenter →
            Analyzer → embed/cluster → Miner → Critic), scoped by education level and curriculum.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/admin/archetype-miner/catalogue" className="text-brand hover:underline">
            Archetype catalogue
          </Link>
          <Link href="/admin/archetype-miner/coverage" className="text-brand hover:underline">
            Chapter/topic coverage
          </Link>
          <Link href="/admin/archetype-miner/families" className="text-brand hover:underline">
            Archetype families
          </Link>
          <Link href="/admin/archetype-miner/cross-run-merge" className="text-brand hover:underline">
            Cross-run merge
          </Link>
          <Link href="/admin/archetype-miner/curriculum-reconciliation" className="text-brand hover:underline">
            Curriculum reconciliation
          </Link>
          <Link href="/admin/archetype-miner/unmatched-chapters" className="text-brand hover:underline">
            Unmatched chapters
          </Link>
          <Link href="/admin/archetype-miner/off-scope-content-scan" className="text-brand hover:underline">
            Off-scope content scan
          </Link>
          <Link href="/admin/archetype-miner/taxonomies" className="text-brand hover:underline">
            Curriculum taxonomies
          </Link>
          <Link href="/admin/archetype-miner/ocr" className="text-brand hover:underline">
            OCR a scanned paper
          </Link>
        </div>
      </div>

      {(pendingReviewCount ?? 0) > 0 && (
        <p className="mt-4 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-2 text-sm text-yellow-800">
          {pendingReviewCount} item(s) pending human review across all runs — open a run below to
          resolve its own review-queue items.
        </p>
      )}

      {/* A now-fixed Stage 3 prompt bug (see stage3Recovery.ts) forced a
          synthesized REVIEW, with no real critic judgment behind it, on
          any candidate a batch response happened to omit -- overwhelmingly
          the dominant reason in the review queue above, not genuine
          ambiguity a human needs to weigh in on. This re-runs Stage 3
          under the fixed prompt on exactly that stuck subset, never on a
          real REVIEW. Only shown once there's actually something to
          recover. */}
      {stage3RecoveryPreview && stage3RecoveryPreview.affectedArchetypes > 0 && (
        <form action={recoverStage3Action} className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800">
          <p>
            {stage3RecoveryPreview.affectedArchetypes} archetype(s) across {stage3RecoveryPreview.affectedRuns} run(s) are
            stuck REVIEW from a since-fixed Stage 3 bug (never actually reviewed by the model) — recovering re-runs
            Stage 3 on just those, in the background.
            {stage3RecoveryPreview.inProgress && (
              <span className="ml-1 font-medium">
                A pass is already running — check `docker logs` for its own &quot;Stage 3 recovery: done.&quot; line, then reload this page.
              </span>
            )}
          </p>
          {/* Disabled while a pass is in progress -- a click here while
              one is already running silently used to fire a SECOND,
              fully independent pass over roughly the same backlog (see
              the service's own comment on why this guard exists), rather
              than either queuing or being rejected visibly. */}
          <button
            type="submit"
            disabled={stage3RecoveryPreview.inProgress}
            className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {stage3RecoveryPreview.inProgress ? "Recovery running…" : "Recover now"}
          </button>
        </form>
      )}

      {/* One-time backfill for student_explanation (see the service's own
          studentExplanationBackfill.ts) -- the plain-language concept
          paragraph now shown in the pattern picker before the Easy/Medium/
          Hard row, for every archetype mined before that field existed.
          Deliberately generated once here, at backfill time, never per
          student click -- see that file's own comment on why. Only shown
          once there's actually something to backfill. */}
      {studentExplanationPreview && studentExplanationPreview.pendingArchetypes > 0 && (
        <form
          action={backfillStudentExplanationAction}
          className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-purple-200 bg-purple-50 px-4 py-2 text-sm text-purple-800"
        >
          <p>
            {studentExplanationPreview.pendingArchetypes} archetype(s) have no student-facing concept explanation yet
            (mined before that field existed) — backfilling generates one for each, once, in the background.
            {studentExplanationPreview.inProgress && (
              <span className="ml-1 font-medium">
                A pass is already running — check `docker logs` for its own &quot;student_explanation backfill: done.&quot; line, then reload this page.
              </span>
            )}
          </p>
          <button
            type="submit"
            disabled={studentExplanationPreview.inProgress}
            className="shrink-0 rounded-lg bg-purple-600 px-3 py-1.5 font-medium text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {studentExplanationPreview.inProgress ? "Backfill running…" : "Backfill now"}
          </button>
        </form>
      )}

      <details className="mt-6 rounded-xl border border-border bg-surface">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium hover:bg-brand/5">
          Submit a new pipeline run
        </summary>
        <SubmitRunForm defaultLlmProvider={health?.llmProvider ?? null} />
      </details>

      <div className="mt-6 rounded-xl border border-border bg-surface">
        <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">Pipeline runs</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px] text-left text-sm">
            <thead className="border-b border-border text-xs uppercase text-foreground/50">
              <tr>
                <th className="px-4 py-3">Submitted</th>
                <th className="px-4 py-3">Education context</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Stats</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((run) => (
                <tr key={run.id} className="border-b border-border last:border-0 hover:bg-brand/5">
                  <td className="px-4 py-3">{new Date(run.created_at).toLocaleString()}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{run.education_context.subject_or_course}</div>
                    <div className="text-xs text-foreground/50">
                      {run.education_context.curriculum_source.name} · {run.education_context.education_stage} ·{" "}
                      {run.education_context.grade_or_year}
                    </div>
                    <span className="mt-1 inline-block rounded-full bg-foreground/10 px-2 py-0.5 text-xs text-foreground/50">
                      {run.llm_provider}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        run.status === "completed"
                          ? "bg-green-100 text-green-700"
                          : run.status === "failed"
                            ? "bg-red-100 text-red-700"
                            : "bg-yellow-100 text-yellow-700"
                      }`}
                    >
                      {STATUS_LABEL[run.status] ?? run.status}
                    </span>
                    {run.error && <div className="mt-1 max-w-xs text-xs text-red-600">{run.error}</div>}
                  </td>
                  <td className="px-4 py-3 text-xs text-foreground/60">
                    {run.stats.segmented != null && <div>Segmented: {run.stats.segmented}</div>}
                    {run.stats.analyzed != null && <div>Analyzed: {run.stats.analyzed}</div>}
                    {run.stats.mined != null && <div>Archetypes: {run.stats.mined}</div>}
                    {run.stats.review_queue != null && <div>Review queue: {run.stats.review_queue}</div>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/admin/archetype-miner/${run.id}`} className="text-brand hover:underline">
                      View
                    </Link>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-foreground/50">
                    No pipeline runs submitted yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
