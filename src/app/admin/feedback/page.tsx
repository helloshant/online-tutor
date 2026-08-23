import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveFeedback, reopenFeedback } from "./actions";

const KIND_LABELS: Record<string, string> = {
  chat_message: "Chat reply",
  topic_summary: "Topic summary",
  exercise: "Exercise",
};

// Where an admin actually fixes the thing this feedback is about -- this
// page only triages/closes the feedback item itself, same division of
// responsibility as everywhere else in this app that has a review queue
// (see topic-summaries and answer-bank, which this links out to).
const KIND_REVIEW_LINK: Record<string, string> = {
  topic_summary: "/admin/topic-summaries",
  exercise: "/admin/answer-bank",
};

const DATE_FORMATTER = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
});

// This is the one place in the admin panel that reflects genuinely live
// student sentiment, not a queue of LLM-generated content awaiting a first
// look (topic-summaries/answer-bank) -- every 👎 here is a student saying
// "this specific thing I was looking at was wrong," which is a stronger,
// more specific signal than the review-gate model ever produces on its own.
export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireAdminPage("feedback");
  const { status: statusParam } = await searchParams;
  const status = statusParam === "resolved" ? "resolved" : "open";

  const admin = createAdminClient();
  const [{ data: rows }, { data: authUsers }, { data: profiles }, { count: openDownCount }] = await Promise.all([
    admin
      .from("answer_feedback")
      .select("*")
      .eq("status", status)
      .order("created_at", { ascending: false })
      .limit(200),
    admin.auth.admin.listUsers({ perPage: 1000 }),
    admin.from("profiles").select("id, full_name"),
    admin
      .from("answer_feedback")
      .select("*", { count: "exact", head: true })
      .eq("status", "open")
      .eq("rating", "down"),
  ]);

  const userById = new Map((authUsers?.users ?? []).map((u) => [u.id, u]));
  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));

  // Down-votes first within a status -- a 👍 is nice to know but never
  // needs action, so it shouldn't push an actual problem report further
  // down the page just because it happened more recently.
  const sortedRows = [...(rows ?? [])].sort((a, b) => {
    if (a.rating !== b.rating) return a.rating === "down" ? -1 : 1;
    return 0;
  });

  return (
    <div>
      <h1 className="text-lg font-semibold">Feedback</h1>
      <p className="mt-1 text-sm text-foreground/60">
        👍/👎 students leave on a chat reply, topic summary, or exercise while they&apos;re looking at
        it -- the one place a live reaction reaches this panel, distinct from the review queues below
        that gate content before it&apos;s ever shown to anyone.
      </p>

      <div className="mt-4 flex gap-4 text-sm">
        <Link
          href="/admin/feedback"
          className={`rounded-full px-3 py-1 font-medium ${status === "open" ? "bg-brand text-white" : "border border-border text-foreground/60 hover:text-foreground"}`}
        >
          Open{openDownCount ? ` (${openDownCount} flagged)` : ""}
        </Link>
        <Link
          href="/admin/feedback?status=resolved"
          className={`rounded-full px-3 py-1 font-medium ${status === "resolved" ? "bg-brand text-white" : "border border-border text-foreground/60 hover:text-foreground"}`}
        >
          Resolved
        </Link>
      </div>

      <div className="mt-4 space-y-3">
        {sortedRows.length === 0 && (
          <p className="text-sm text-foreground/50">
            {status === "open" ? "No open feedback." : "No resolved feedback yet."}
          </p>
        )}
        {sortedRows.map((row) => {
          const user = userById.get(row.user_id);
          const name = nameById.get(row.user_id) ?? user?.email ?? "(unknown student)";
          const reviewLink = KIND_REVIEW_LINK[row.kind];
          return (
            <div key={row.id} className="rounded-xl border border-border bg-surface p-4 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-base">{row.rating === "down" ? "👎" : "👍"}</span>
                    <span className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">
                      {KIND_LABELS[row.kind] ?? row.kind}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-foreground/50">
                    {name} · {DATE_FORMATTER.format(new Date(row.created_at))}
                  </p>
                </div>
                <form action={status === "open" ? resolveFeedback.bind(null, row.id) : reopenFeedback.bind(null, row.id)}>
                  <button type="submit" className="text-xs font-medium text-brand hover:underline">
                    {status === "open" ? "Mark resolved" : "Reopen"}
                  </button>
                </form>
              </div>

              {row.question && <p className="mt-3 text-xs font-medium text-foreground/60">{row.question}</p>}
              <p className="mt-1 whitespace-pre-wrap rounded-lg bg-background p-3 text-foreground/80">
                {row.content_snapshot}
              </p>
              {row.note && (
                <p className="mt-2 text-xs text-foreground/70">
                  <span className="font-medium">Student note:</span> {row.note}
                </p>
              )}
              {reviewLink && (
                <Link href={reviewLink} className="mt-2 inline-block text-xs font-medium text-brand hover:underline">
                  Review in {KIND_LABELS[row.kind]?.toLowerCase() ?? "queue"} →
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
