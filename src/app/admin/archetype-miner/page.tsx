import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getArchetypeMinerHealth } from "@/lib/archetypeMinerClient";
import { SubmitRunForm } from "./submit-run-form";
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

  const [{ data: runs }, { count: pendingReviewCount }, health] = await Promise.all([
    admin.from("archetype_pipeline_runs").select("*").order("created_at", { ascending: false }).limit(50),
    admin.from("archetype_review_queue").select("*", { count: "exact", head: true }).eq("status", "pending"),
    getArchetypeMinerHealth(),
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
          <Link href="/admin/archetype-miner/families" className="text-brand hover:underline">
            Archetype families
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
