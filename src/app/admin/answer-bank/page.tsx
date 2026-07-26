import { requireAdminPage } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { AnswerValidationStatus } from "@/lib/supabase/types";
import { approveAnswer, deleteAnswer, rejectAnswer, restoreAnswer } from "./actions";

const STATUS_FILTERS: { value: AnswerValidationStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending_review", label: "Pending review" },
  { value: "auto_approved", label: "Auto-approved" },
  { value: "admin_approved", label: "Admin-approved" },
  { value: "rejected", label: "Rejected" },
];

const STATUS_STYLES: Record<AnswerValidationStatus, string> = {
  auto_approved: "bg-green-100 text-green-700",
  admin_approved: "bg-blue-100 text-blue-700",
  pending_review: "bg-yellow-100 text-yellow-700",
  rejected: "bg-red-100 text-red-700",
};

export default async function AnswerBankPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireAdminPage("answer_bank");
  const { status } = await searchParams;
  const activeStatus = (status as AnswerValidationStatus | "all" | undefined) ?? "all";
  const supabase = await createClient();

  let query = supabase
    .from("answered_questions")
    .select("*, boards(name), grades(name), subjects(name)")
    .order("created_at", { ascending: false })
    .limit(200);

  if (activeStatus !== "all") {
    query = query.eq("validation_status", activeStatus);
  }

  const { data: rows } = await query;

  return (
    <div>
      <h1 className="text-xl font-semibold">Answer bank</h1>
      <p className="mt-1 max-w-3xl text-sm text-foreground/60">
        Questions and answers the orchestrator has learned from real student conversations, so
        repeat questions can be served from the database instead of costing another LLM call. Every
        entry passes an automatic quality check on arrival; only <b>auto-approved</b> and{" "}
        <b>admin-approved</b> entries are ever served to a student &mdash; <b>pending review</b>{" "}
        entries need your confirmation first, and <b>rejected</b> ones are kept only for reference
        and never served.
      </p>

      <div className="mt-4 flex flex-wrap gap-2 text-sm">
        {STATUS_FILTERS.map((f) => (
          <a
            key={f.value}
            href={f.value === "all" ? "/admin/answer-bank" : `/admin/answer-bank?status=${f.value}`}
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

      <div className="mt-6 space-y-3">
        {(rows ?? []).map((row) => {
          const board = (row as unknown as { boards: { name: string } | null }).boards;
          const grade = (row as unknown as { grades: { name: string } | null }).grades;
          const subject = (row as unknown as { subjects: { name: string } | null }).subjects;
          return (
            <div key={row.id} className="rounded-xl border border-border bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2 text-xs text-foreground/50">
                <span
                  className={`rounded-full px-2 py-0.5 font-medium ${STATUS_STYLES[row.validation_status]}`}
                >
                  {row.validation_status.replace("_", " ")}
                </span>
                <span>{board?.name ?? "—"}</span>
                <span>&middot;</span>
                <span>{grade?.name ?? "—"}</span>
                <span>&middot;</span>
                <span>{subject?.name ?? "—"}</span>
                <span>&middot;</span>
                <span>{row.medium}</span>
                <span>&middot;</span>
                <span>
                  {row.hit_count} hit{row.hit_count === 1 ? "" : "s"}
                </span>
              </div>
              <p className="mt-2 text-sm font-medium">{row.question}</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/70">{row.answer}</p>
              <div className="mt-3 flex gap-4 text-xs">
                {row.validation_status !== "admin_approved" && (
                  <form action={approveAnswer.bind(null, row.id)}>
                    <button className="font-medium text-green-700 hover:underline">Approve</button>
                  </form>
                )}
                {row.validation_status !== "rejected" && (
                  <form
                    action={rejectAnswer.bind(null, {
                      id: row.id,
                      boardId: row.board_id,
                      gradeId: row.grade_id,
                      subjectId: row.subject_id,
                      medium: row.medium,
                      question: row.question,
                    })}
                  >
                    <button className="font-medium text-red-600 hover:underline">Reject</button>
                  </form>
                )}
                {(row.validation_status === "rejected" || row.validation_status === "admin_approved") && (
                  <form action={restoreAnswer.bind(null, row.id)}>
                    <button className="text-foreground/60 hover:underline">Reset to auto</button>
                  </form>
                )}
                <form
                  action={deleteAnswer.bind(null, {
                    id: row.id,
                    boardId: row.board_id,
                    gradeId: row.grade_id,
                    subjectId: row.subject_id,
                    medium: row.medium,
                    question: row.question,
                  })}
                >
                  <button className="text-foreground/40 hover:underline">Delete</button>
                </form>
              </div>
            </div>
          );
        })}
        {(rows ?? []).length === 0 && (
          <p className="text-sm text-foreground/50">No entries yet for this filter.</p>
        )}
      </div>
    </div>
  );
}
