import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import type { BroadcastStatus, BroadcastType } from "@/lib/supabase/types";
import { NewBroadcastForm } from "./new-broadcast-form";
import { deleteBroadcast, sendBroadcastAction } from "./actions";

const TYPE_LABELS: Record<BroadcastType, string> = {
  announcement: "Announcement",
  promotion: "Promotion",
  feedback: "Feedback request",
  test: "Test",
  exam: "Exam",
};

const STATUS_STYLES: Record<BroadcastStatus, string> = {
  draft: "bg-foreground/10 text-foreground/60",
  sent: "bg-green-100 text-green-700",
  closed: "bg-foreground/10 text-foreground/40",
};

type BroadcastRow = {
  id: string;
  type: BroadcastType;
  title: string;
  status: BroadcastStatus;
  sent_at: string | null;
  created_at: string;
  boards: { name: string } | null;
  grades: { name: string } | null;
  subjects: { name: string } | null;
  medium: string | null;
};

export default async function BroadcastsPage() {
  await requireAdminPage("broadcasts");

  // broadcasts has RLS enabled with zero client-facing policies (see
  // 0028_broadcast_service.sql) -- same "backend-only table" posture as
  // answered_questions/chapter_documents/topic_summaries, so this needs the
  // service-role client the same way those admin pages do.
  const supabase = createAdminClient();

  const [{ data: boards }, { data: grades }, { data: subjects }, { data: broadcasts }] = await Promise.all([
    supabase.from("boards").select("id, name").order("name"),
    supabase.from("grades").select("id, name").order("level"),
    supabase.from("subjects").select("id, name").order("name"),
    supabase
      .from("broadcasts")
      .select("id, type, title, status, sent_at, created_at, medium, boards(name), grades(name), subjects(name)")
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const rows = (broadcasts ?? []) as unknown as BroadcastRow[];

  return (
    <div>
      <h1 className="text-lg font-semibold">Broadcasts</h1>
      <p className="mt-1 text-sm text-foreground/60">
        Send an announcement, promotion, feedback request, or test to a segment of registered
        students -- filtered by board/grade/subject/medium, same as the rest of the catalog, or left
        unfiltered to reach everyone. A draft reaches nobody until you open it and hit Send.
      </p>

      <NewBroadcastForm boards={boards ?? []} grades={grades ?? []} subjects={subjects ?? []} />

      <div className="mt-6 space-y-2">
        {rows.length === 0 && <p className="text-sm text-foreground/50">No broadcasts yet.</p>}
        {rows.map((row) => (
          <div
            key={row.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface p-3 text-sm"
          >
            <div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">
                  {TYPE_LABELS[row.type]}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[row.status]}`}>
                  {row.status}
                </span>
                <Link href={`/admin/broadcasts/${row.id}`} className="font-medium hover:underline">
                  {row.title}
                </Link>
              </div>
              <p className="mt-1 text-xs text-foreground/50">
                {[row.boards?.name ?? "All boards", row.grades?.name ?? "All grades", row.subjects?.name ?? "All subjects", row.medium ?? "All mediums"].join(" · ")}
                {" · "}
                {row.status === "sent" && row.sent_at
                  ? `sent ${new Date(row.sent_at).toLocaleString()}`
                  : `created ${new Date(row.created_at).toLocaleString()}`}
              </p>
            </div>
            <div className="flex gap-2">
              {row.status === "draft" && (
                <>
                  <form action={sendBroadcastAction.bind(null, row.id)}>
                    <button className="rounded-lg border border-brand px-3 py-1.5 text-xs font-medium text-brand hover:bg-brand/5">
                      Send
                    </button>
                  </form>
                  <form action={deleteBroadcast.bind(null, row.id)}>
                    <ConfirmSubmitButton
                      confirmMessage="Delete this draft?"
                      className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground/60 hover:bg-brand/5"
                    >
                      Delete
                    </ConfirmSubmitButton>
                  </form>
                </>
              )}
              <Link
                href={`/admin/broadcasts/${row.id}`}
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground/70 hover:bg-brand/5"
              >
                {row.status === "draft" ? "Edit" : "View"}
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
