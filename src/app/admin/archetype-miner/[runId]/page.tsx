import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveReviewItemAction } from "../actions";
import type { ArchetypeRow, PipelineRunRow, ReviewQueueRow } from "@/lib/archetypeMinerTypes";

const DECISION_COLOR: Record<string, string> = {
  KEEP: "bg-green-100 text-green-700",
  ADD: "bg-green-100 text-green-700",
  REVISE: "bg-blue-100 text-blue-700",
  MERGE: "bg-purple-100 text-purple-700",
  SPLIT: "bg-purple-100 text-purple-700",
  REMOVE: "bg-foreground/10 text-foreground/60",
  REVIEW: "bg-yellow-100 text-yellow-700",
};

export default async function ArchetypeMinerRunPage({ params }: { params: Promise<{ runId: string }> }) {
  await requireAdminPage("archetype_miner");
  const { runId } = await params;
  const admin = createAdminClient();

  const [{ data: run }, { data: archetypeRows }, { data: reviewRows }] = await Promise.all([
    admin.from("archetype_pipeline_runs").select("*").eq("id", runId).maybeSingle(),
    admin.from("archetypes").select("*").eq("run_id", runId).order("created_at", { ascending: true }),
    admin
      .from("archetype_review_queue")
      .select("*")
      .eq("run_id", runId)
      .order("created_at", { ascending: true }),
  ]);

  if (!run) notFound();

  const runRow = run as PipelineRunRow;
  const archetypes = (archetypeRows ?? []) as ArchetypeRow[];
  const reviewItems = (reviewRows ?? []) as ReviewQueueRow[];
  const pending = reviewItems.filter((i) => i.status === "pending");
  const resolved = reviewItems.filter((i) => i.status === "resolved");

  return (
    <div>
      <Link href="/admin/archetype-miner" className="text-sm text-brand hover:underline">
        ← All runs
      </Link>

      <div className="mt-4 rounded-xl border border-border bg-surface p-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-semibold">
              {runRow.education_context.subject_or_course} — {runRow.education_context.curriculum_source.name}
            </h1>
            <p className="mt-1 text-sm text-foreground/60">
              {runRow.education_context.education_stage} · grade/year {runRow.education_context.grade_or_year}
              {runRow.education_context.program_or_stream && ` · ${runRow.education_context.program_or_stream}`}
            </p>
            <p className="mt-1 text-xs text-foreground/40">
              Submitted {new Date(runRow.created_at).toLocaleString()}
              {runRow.completed_at && ` · finished ${new Date(runRow.completed_at).toLocaleString()}`}
              {" · "}
              {runRow.llm_provider}
            </p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-sm font-medium ${
              runRow.status === "completed"
                ? "bg-green-100 text-green-700"
                : runRow.status === "failed"
                  ? "bg-red-100 text-red-700"
                  : "bg-yellow-100 text-yellow-700"
            }`}
          >
            {runRow.status}
          </span>
        </div>

        {runRow.error && <p className="mt-3 text-sm text-red-600">{runRow.error}</p>}

        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-6">
          <div>
            <dt className="text-foreground/50">Segmented</dt>
            <dd className="font-medium">{runRow.stats.segmented ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-foreground/50">Analyzed</dt>
            <dd className="font-medium">{runRow.stats.analyzed ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-foreground/50" title="Shared stem/stimulus records with no independent reasoning task of their own -- not a failure.">
              Stems excluded
            </dt>
            <dd className="font-medium">{runRow.stats.stems_excluded ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-foreground/50">Clusters</dt>
            <dd className="font-medium">{runRow.stats.clusters ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-foreground/50">Archetypes mined</dt>
            <dd className="font-medium">{runRow.stats.mined ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-foreground/50">Review queue</dt>
            <dd className="font-medium">{runRow.stats.review_queue ?? "—"}</dd>
          </div>
        </dl>
      </div>

      {pending.length > 0 && (
        <div className="mt-6 rounded-xl border border-yellow-200 bg-yellow-50 p-5">
          <h2 className="text-sm font-semibold text-yellow-800">Pending review ({pending.length})</h2>
          <div className="mt-3 space-y-3">
            {pending.map((item) => (
              <div key={item.queue_item_id} className="rounded-lg border border-yellow-300 bg-white p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2 text-xs text-foreground/50">
                  <span className="rounded-full bg-yellow-100 px-2 py-0.5 font-medium text-yellow-800">
                    {item.source}
                  </span>
                  <span>ref: {item.reference_id}</span>
                  {item.confidence != null && <span>confidence: {item.confidence.toFixed(2)}</span>}
                </div>
                <p className="mt-1.5">{item.reason}</p>
                <form
                  action={resolveReviewItemAction.bind(null, runId, item.queue_item_id)}
                  className="mt-2 flex flex-wrap items-center gap-2"
                >
                  <input
                    name="resolution"
                    required
                    placeholder="Resolution note"
                    className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 text-xs"
                  />
                  <button className="shrink-0 rounded-lg bg-brand px-3 py-1 text-xs font-medium text-white hover:bg-brand-dark">
                    Resolve
                  </button>
                </form>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 rounded-xl border border-border bg-surface">
        <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">
          Archetype catalogue ({archetypes.length})
        </h2>
        <div className="divide-y divide-border">
          {archetypes.map((row) => {
            const a = row.archetype;
            return (
              <div key={row.archetype_id} className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium">{a.name}</h3>
                  <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-xs">{row.status}</span>
                  {row.critic_decision && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${DECISION_COLOR[row.critic_decision] ?? "bg-foreground/10 text-foreground/60"}`}
                    >
                      {row.critic_decision}
                    </span>
                  )}
                  <span className="text-xs text-foreground/40">confidence {a.mining_confidence?.toFixed(2)}</span>
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
                  {a.stats.question_count} question(s) · {a.supporting_question_ids.length} supporting id(s)
                  {!a.generator_usable && " · not yet generator-usable"}
                </p>
                {a.critic_rationale && (
                  <p className="mt-1 text-xs text-foreground/50">
                    <span className="font-medium">Critic:</span> {a.critic_rationale}
                  </p>
                )}
              </div>
            );
          })}
          {archetypes.length === 0 && (
            <p className="p-4 text-center text-sm text-foreground/50">
              No archetypes mined yet — the run may still be in progress.
            </p>
          )}
        </div>
      </div>

      {resolved.length > 0 && (
        <details className="mt-6 rounded-xl border border-border bg-surface">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium hover:bg-brand/5">
            Resolved review-queue items ({resolved.length})
          </summary>
          <div className="space-y-2 border-t border-border p-4 text-sm">
            {resolved.map((item) => (
              <div key={item.queue_item_id} className="rounded-lg border border-border p-3">
                <div className="text-xs text-foreground/50">
                  {item.source} · ref: {item.reference_id}
                </div>
                <p className="mt-1">{item.reason}</p>
                <p className="mt-1 text-foreground/60">
                  <span className="font-medium">Resolution:</span> {item.resolution}
                </p>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
