import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { submitRunAction } from "./actions";
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

  const { data: runs } = await admin
    .from("archetype_pipeline_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  const { count: pendingReviewCount } = await admin
    .from("archetype_review_queue")
    .select("*", { count: "exact", head: true })
    .eq("status", "pending");

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
          <Link href="/admin/archetype-miner/families" className="text-brand hover:underline">
            Archetype families
          </Link>
          <Link href="/admin/archetype-miner/taxonomies" className="text-brand hover:underline">
            Curriculum taxonomies
          </Link>
        </div>
      </div>

      {(pendingReviewCount ?? 0) > 0 && (
        <p className="mt-4 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-2 text-sm text-yellow-800">
          {pendingReviewCount} item(s) pending human review across all runs — open a run below to
          resolve its own review-queue items.
        </p>
      )}

      <details className="mt-6 rounded-xl border border-border bg-surface">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium hover:bg-brand/5">
          Submit a new pipeline run
        </summary>
        <form action={submitRunAction} className="space-y-4 border-t border-border p-4">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground/50">
              Education context
            </h3>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-foreground/60">
                Education stage
                <select
                  name="educationStage"
                  required
                  className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                >
                  <option value="secondary">Secondary</option>
                  <option value="senior_secondary">Senior secondary</option>
                  <option value="undergraduate">Undergraduate</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-foreground/60">
                Grade / year (e.g. &quot;10&quot;, &quot;UG-2&quot;)
                <input
                  name="gradeOrYear"
                  required
                  className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-foreground/60">
                Curriculum source type
                <select
                  name="curriculumSourceType"
                  required
                  className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                >
                  <option value="school_board">School board</option>
                  <option value="university_program">University program</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-foreground/60">
                Curriculum source name (e.g. &quot;CBSE&quot;, &quot;Anna University B.Tech CSE&quot;)
                <input
                  name="curriculumSourceName"
                  required
                  className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-foreground/60">
                Country / region (optional)
                <input
                  name="countryOrRegion"
                  className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-foreground/60">
                Subject / course
                <input
                  name="subjectOrCourse"
                  required
                  className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-foreground/60">
                Program / stream (optional)
                <input
                  name="programOrStream"
                  className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
                />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-foreground/60">
                <input type="checkbox" name="taxonomySupplied" className="h-4 w-4" />A curriculum
                taxonomy is available for this source
              </label>
            </div>
            <label className="mt-3 flex flex-col gap-1 text-xs text-foreground/60">
              Curriculum taxonomy text (optional — leave blank to use a saved taxonomy for this
              curriculum source, if one exists; see &quot;Curriculum taxonomies&quot; above)
              <textarea
                name="curriculumTaxonomyText"
                rows={3}
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
              />
            </label>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground/50">Input</h3>
            <label className="mt-2 flex flex-col gap-1 text-xs text-foreground/60">
              Input kind
              <select
                name="inputKind"
                required
                className="w-fit rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
              >
                <option value="raw_papers">Raw paper text (Stage 0 segments it)</option>
                <option value="pre_segmented">Already-segmented questions (JSON)</option>
              </select>
            </label>

            <p className="mt-3 text-xs text-foreground/40">
              Fill in ONE of the two sections below, matching your chosen input kind.
            </p>

            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <input
                name="paperSubject"
                placeholder="Paper subject (defaults to subject/course above)"
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
              />
              <input
                name="paperYear"
                type="number"
                placeholder="Paper year, e.g. 2023"
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
              />
              <input
                name="paperBoard"
                placeholder="Paper board/institution name (defaults to curriculum source name)"
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
              />
              <input
                name="paperClass"
                placeholder="Paper class/level label (defaults to grade/year above)"
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
              />
              <input
                name="paperSetCode"
                placeholder="Set code (optional)"
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
              />
              <input
                name="paperSourceUrl"
                placeholder="Source URL (optional)"
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
              />
              <select
                name="paperType"
                defaultValue="board_exam"
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
              >
                <option value="board_exam">Board exam</option>
                <option value="sample_paper">Sample paper</option>
                <option value="compartment">Compartment</option>
              </select>
              <select
                name="extractionMethod"
                defaultValue="native_text"
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
              >
                <option value="native_text">Native text</option>
                <option value="ocr">OCR</option>
              </select>
            </div>
            <textarea
              name="rawText"
              rows={8}
              placeholder="Paste the raw extracted paper text here (for input kind: raw paper text)"
              className="mt-2 w-full rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-xs"
            />

            <textarea
              name="preSegmentedJson"
              rows={8}
              placeholder='Or paste a JSON array of already-segmented questions here (for input kind: already-segmented). Each object needs at least question_id, raw_text, cleaned_text.'
              className="mt-3 w-full rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-xs"
            />
          </div>

          <button className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-dark">
            Submit run
          </button>
        </form>
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
