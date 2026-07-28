import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { MathText } from "@/components/math-text";
import type { AnswerValidationStatus, Medium } from "@/lib/supabase/types";
import {
  addTag,
  approveAnswer,
  bulkImportAnswers,
  deleteAnswer,
  rejectAnswer,
  removeTag,
  restoreAnswer,
} from "./actions";

const STATUS_FILTERS: { value: AnswerValidationStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending_review", label: "Pending review" },
  { value: "auto_approved", label: "Auto-approved" },
  { value: "admin_approved", label: "Admin-approved" },
  { value: "rejected", label: "Rejected" },
];

const MEDIUMS: Medium[] = ["English", "Hindi", "Bengali"];

const STATUS_STYLES: Record<AnswerValidationStatus, string> = {
  auto_approved: "bg-green-100 text-green-700",
  admin_approved: "bg-blue-100 text-blue-700",
  pending_review: "bg-yellow-100 text-yellow-700",
  rejected: "bg-red-100 text-red-700",
};

export default async function AnswerBankPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; tag?: string }>;
}) {
  await requireAdminPage("answer_bank");
  const { status, tag } = await searchParams;
  const activeStatus = (status as AnswerValidationStatus | "all" | undefined) ?? "all";
  const activeTag = tag?.trim() || null;
  // answered_questions has RLS enabled with zero policies (see
  // supabase/migrations/0005_answer_bank.sql) -- it's a backend
  // implementation detail the orchestrator writes to with its service-role
  // key, so this admin page needs the same service-role client to read it;
  // the ordinary session-scoped client would silently see zero rows.
  const supabase = createAdminClient();

  let query = supabase
    .from("answered_questions")
    .select("*, boards(name), grades(name), subjects(name)")
    .order("created_at", { ascending: false })
    .limit(200);

  if (activeStatus !== "all") {
    query = query.eq("validation_status", activeStatus);
  }
  if (activeTag) {
    query = query.contains("tags", [activeTag]);
  }

  const [{ data: rows }, { data: boards }, { data: grades }, { data: subjects }] = await Promise.all([
    query,
    supabase.from("boards").select("*").order("name"),
    supabase.from("grades").select("*").order("level"),
    supabase.from("subjects").select("*").order("name"),
  ]);

  function statusHref(value: AnswerValidationStatus | "all") {
    const params = new URLSearchParams();
    if (value !== "all") params.set("status", value);
    if (activeTag) params.set("tag", activeTag);
    const qs = params.toString();
    return qs ? `/admin/answer-bank?${qs}` : "/admin/answer-bank";
  }

  function tagHref(value: string) {
    const params = new URLSearchParams();
    if (activeStatus !== "all") params.set("status", activeStatus);
    params.set("tag", value);
    return `/admin/answer-bank?${params.toString()}`;
  }

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
            href={statusHref(f.value)}
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

      <form method="get" className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        {activeStatus !== "all" && <input type="hidden" name="status" value={activeStatus} />}
        <input
          name="tag"
          defaultValue={activeTag ?? ""}
          placeholder="Filter by tag (e.g. Ganit Prakash, WBJEE 2023)"
          className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        />
        <button className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-brand/5">
          Filter
        </button>
        {activeTag && (
          <a href={statusHref(activeStatus)} className="text-xs text-foreground/50 hover:underline">
            Clear tag filter
          </a>
        )}
      </form>

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
              <p className="mt-2 text-sm font-medium">
                <MathText text={row.question} />
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/70">
                <MathText text={row.answer} />
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {row.tags.map((t) => (
                  <span
                    key={t}
                    className="flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-xs text-brand"
                  >
                    <a href={tagHref(t)} className="hover:underline">
                      {t}
                    </a>
                    <form action={removeTag.bind(null, row.id, t)}>
                      <button type="submit" title={`Remove tag "${t}"`} className="text-brand/60 hover:text-brand">
                        ×
                      </button>
                    </form>
                  </span>
                ))}
                <form action={addTag.bind(null, row.id)} className="flex items-center gap-1">
                  <input
                    name="tag"
                    placeholder="+ tag"
                    className="w-24 rounded-full border border-dashed border-border bg-background px-2 py-0.5 text-xs outline-none focus:border-brand"
                  />
                </form>
              </div>

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

      <details className="mt-8 rounded-lg border border-border">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium hover:bg-brand/5">
          Bulk import (e.g. a textbook or past exam paper)
        </summary>
        <form action={bulkImportAnswers} className="space-y-3 px-3 pb-4">
          <p className="text-xs text-foreground/60">
            For real, sourced questions (a textbook&apos;s exercise set, a past exam paper) rather
            than LLM-generated practice — these are stored <b>admin-approved</b> immediately, no
            quality check applied, and tagged so students can find them by source (e.g. &ldquo;Ganit
            Prakash&rdquo; or &ldquo;WBJEE 2023&rdquo;). Not scoped to a single syllabus topic, since
            a book chapter or exam paper usually spans several.
          </p>
          <div className="flex flex-wrap gap-2">
            <select
              name="boardId"
              required
              className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
            >
              <option value="">Board</option>
              {(boards ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <select
              name="gradeId"
              required
              className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
            >
              <option value="">Grade</option>
              {(grades ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <select
              name="subjectId"
              required
              className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
            >
              <option value="">Subject</option>
              {(subjects ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select
              name="medium"
              required
              className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
            >
              <option value="">Medium</option>
              {MEDIUMS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <input
              name="tags"
              placeholder="Tags, comma-separated (e.g. Ganit Prakash, Chapter 3)"
              className="min-w-[16rem] flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
            />
          </div>
          <textarea
            name="bulkText"
            rows={8}
            required
            placeholder={
              "Q: <question>\nA: <complete solution>\n---\nQ: <next question>\nA: <its solution>"
            }
            className="w-full rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-sm"
          />
          <button className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark">
            Import
          </button>
        </form>
      </details>
    </div>
  );
}
