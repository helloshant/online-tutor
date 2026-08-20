import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { MathText } from "@/components/math-text";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import type { TopicSummaryValidationStatus } from "@/lib/supabase/types";
import { approveTopicSummary, deleteTopicSummary, rejectTopicSummary } from "./actions";

const STATUS_FILTERS: { value: TopicSummaryValidationStatus | "all"; label: string }[] = [
  { value: "pending_review", label: "Pending review" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All" },
];

const STATUS_STYLES: Record<TopicSummaryValidationStatus, string> = {
  pending_review: "bg-yellow-100 text-yellow-700",
  approved: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
};

// Nested embed through syllabus_topics -- topic_summaries only carries
// topic_id, not board/grade/subject/medium of its own (unlike
// answered_questions, which denormalizes those for its FTS RPC's WHERE
// clause; there's no equivalent performance reason to do that here). The
// shape below is inferred from the actual foreign keys, not fully expressed
// by this file's hand-maintained Database["public"]["Tables"] types, hence
// the cast below (same pattern the dashboard's own subject joins use).
type TopicSummaryRow = {
  id: string;
  topic_id: string;
  summary: string;
  validation_status: TopicSummaryValidationStatus;
  updated_at: string;
  syllabus_topics: {
    chapter: string;
    topic: string;
    medium: string;
    boards: { name: string } | null;
    grades: { name: string } | null;
    subjects: { name: string } | null;
  } | null;
};

export default async function TopicSummariesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireAdminPage("topic_summaries");
  const { status } = await searchParams;
  const activeStatus = (status as TopicSummaryValidationStatus | "all" | undefined) ?? "pending_review";

  // Service-role client, same as every other admin page reading a table
  // whose RLS is scoped to admins-only rather than broad authenticated
  // access (0026_topic_summary_review.sql's is_admin() policies would in
  // principle let the ordinary session read this directly, but every
  // sibling admin page in this app already goes through the service-role
  // client for consistency, so this does too).
  const supabase = createAdminClient();
  let query = supabase
    .from("topic_summaries")
    .select("id, topic_id, summary, validation_status, updated_at, syllabus_topics(chapter, topic, medium, boards(name), grades(name), subjects(name))")
    .order("updated_at", { ascending: false })
    .limit(200);
  if (activeStatus !== "all") query = query.eq("validation_status", activeStatus);

  const { data } = await query;
  const rows = (data ?? []) as unknown as TopicSummaryRow[];

  return (
    <div>
      <h1 className="text-xl font-semibold">Topic summaries</h1>
      <p className="mt-1 max-w-3xl text-sm text-foreground/60">
        Quick-reference summaries shown when a student opens a topic in the syllabus panel. When
        admin-authored chapter notes exist for a topic, those are shown directly and never reach this
        queue. Otherwise the LLM generates one, but it stays <b>pending review</b> -- not served to any
        student -- until you <b>approve</b> it here; a single approved (or rejected) summary is then
        reused by everyone who opens that topic, so it&rsquo;s worth a look before it goes out to the
        whole class.
      </p>

      <div className="mt-4 flex flex-wrap gap-2 text-sm">
        {STATUS_FILTERS.map((f) => (
          <a
            key={f.value}
            href={f.value === "pending_review" ? "/admin/topic-summaries" : `/admin/topic-summaries?status=${f.value}`}
            className={`rounded-full border px-3 py-1 ${
              activeStatus === f.value
                ? "border-brand bg-brand text-white"
                : "border-border text-foreground/70 hover:bg-brand/5"
            }`}
          >
            {f.label}
          </a>
        ))}
      </div>

      <div className="mt-4 space-y-3">
        {rows.length === 0 && (
          <p className="rounded-xl border border-border bg-surface p-4 text-sm text-foreground/50">
            Nothing here.
          </p>
        )}
        {rows.map((row) => {
          const t = row.syllabus_topics;
          return (
            <div key={row.id} className="rounded-xl border border-border bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-xs text-foreground/50">
                    {t ? `${t.boards?.name ?? "—"} · ${t.grades?.name ?? "—"} · ${t.subjects?.name ?? "—"} · ${t.medium}` : "—"}
                  </p>
                  <p className="text-sm font-semibold">{t ? `${t.chapter} — ${t.topic}` : "(topic removed)"}</p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[row.validation_status]}`}
                >
                  {row.validation_status.replace("_", " ")}
                </span>
              </div>

              <div className="mt-3 max-h-64 overflow-y-auto rounded-lg bg-background p-3 text-sm">
                <MathText text={row.summary} />
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-foreground/40">
                  Updated {new Date(row.updated_at).toLocaleString()}
                </span>
                <div className="ml-auto flex gap-2">
                  {row.validation_status !== "approved" && (
                    <form action={approveTopicSummary.bind(null, row.id)}>
                      <button className="rounded-lg border border-green-600 px-3 py-1.5 font-medium text-green-700 hover:bg-green-50">
                        Approve
                      </button>
                    </form>
                  )}
                  {row.validation_status !== "rejected" && (
                    <form action={rejectTopicSummary.bind(null, row.id, row.topic_id)}>
                      <button className="rounded-lg border border-red-600 px-3 py-1.5 font-medium text-red-700 hover:bg-red-50">
                        Reject
                      </button>
                    </form>
                  )}
                  <form action={deleteTopicSummary.bind(null, row.id, row.topic_id)}>
                    <ConfirmSubmitButton
                      confirmMessage="Delete this summary entirely? The next student to open this topic will trigger a fresh one."
                      className="rounded-lg border border-border px-3 py-1.5 font-medium text-foreground/60 hover:bg-brand/5"
                    >
                      Delete
                    </ConfirmSubmitButton>
                  </form>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
