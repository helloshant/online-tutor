import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { MathText } from "@/components/math-text";
import type { AnswerValidationStatus, Medium } from "@/lib/supabase/types";
import {
  addImage,
  addTag,
  approveAnswer,
  deleteAnswer,
  rejectAnswer,
  removeImage,
  removeTag,
  restoreAnswer,
} from "./actions";
import { BulkImportForm } from "./bulk-import-form";

const STATUS_FILTERS: { value: AnswerValidationStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending_review", label: "Pending review" },
  { value: "auto_approved", label: "Auto-approved" },
  { value: "admin_approved", label: "Admin-approved" },
  { value: "rejected", label: "Rejected" },
];

const MEDIUMS: Medium[] = ["English", "Hindi", "Bengali"];

const PAGE_SIZE = 25;

const STATUS_STYLES: Record<AnswerValidationStatus, string> = {
  auto_approved: "bg-green-100 text-green-700",
  admin_approved: "bg-blue-100 text-blue-700",
  pending_review: "bg-yellow-100 text-yellow-700",
  rejected: "bg-red-100 text-red-700",
};

export default async function AnswerBankPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    tag?: string;
    board?: string;
    grade?: string;
    subject?: string;
    medium?: string;
    topic?: string;
    page?: string;
  }>;
}) {
  await requireAdminPage("answer_bank");
  const { status, tag, board, grade, subject, medium, topic, page } = await searchParams;
  const activeStatus = (status as AnswerValidationStatus | "all" | undefined) ?? "all";
  const activeTag = tag?.trim() || null;
  const activeBoard = board || null;
  const activeGrade = grade || null;
  const activeSubject = subject || null;
  const activeMedium = (medium as Medium | undefined) || null;
  const activeTopic = topic || null;
  const activePage = Math.max(1, parseInt(page ?? "1", 10) || 1);
  const from = (activePage - 1) * PAGE_SIZE;
  // answered_questions has RLS enabled with zero policies (see
  // supabase/migrations/0005_answer_bank.sql) -- it's a backend
  // implementation detail the orchestrator writes to with its service-role
  // key, so this admin page needs the same service-role client to read it;
  // the ordinary session-scoped client would silently see zero rows.
  const supabase = createAdminClient();

  // Fetches one row past the page size, purely to tell whether a Next page
  // is worth offering -- cheaper than a separate COUNT query, and this table
  // only ever grows, so an exact count would go stale immediately anyway
  // (same pattern as /api/answer-bank/search).
  let query = supabase
    .from("answered_questions")
    .select("*, boards(name), grades(name), subjects(name), syllabus_topics(chapter, topic)")
    .order("created_at", { ascending: false })
    .range(from, from + PAGE_SIZE);

  if (activeStatus !== "all") query = query.eq("validation_status", activeStatus);
  if (activeTag) query = query.contains("tags", [activeTag]);
  if (activeBoard) query = query.eq("board_id", activeBoard);
  if (activeGrade) query = query.eq("grade_id", activeGrade);
  if (activeSubject) query = query.eq("subject_id", activeSubject);
  if (activeMedium) query = query.eq("medium", activeMedium);
  if (activeTopic) query = query.eq("topic_id", activeTopic);

  // The topic filter's own option list is only meaningful once a specific
  // board/grade/subject/medium is selected -- a topic name isn't unique
  // across the whole catalog, so there's no useful "topic" filter without
  // first narrowing to the syllabus it belongs to.
  const filterTopicsQuery =
    activeBoard && activeGrade && activeSubject && activeMedium
      ? supabase
          .from("syllabus_topics")
          .select("id, chapter, topic")
          .eq("board_id", activeBoard)
          .eq("grade_id", activeGrade)
          .eq("subject_id", activeSubject)
          .eq("medium", activeMedium)
          .order("sort_order")
      : null;

  const [{ data: fetchedRows }, { data: boards }, { data: grades }, { data: subjects }, filterTopicsResult] =
    await Promise.all([
      query,
      supabase.from("boards").select("*").order("name"),
      supabase.from("grades").select("*").order("level"),
      supabase.from("subjects").select("*").order("name"),
      filterTopicsQuery ?? Promise.resolve({ data: null }),
    ]);
  const filterTopics = filterTopicsResult.data;
  const hasNextPage = (fetchedRows?.length ?? 0) > PAGE_SIZE;
  const rows = (fetchedRows ?? []).slice(0, PAGE_SIZE);

  // Merges the current filters with the given overrides -- every link/form
  // in this page goes through this so clicking a status pill or a tag chip
  // never drops the board/grade/subject/medium/topic scope already applied,
  // and vice versa.
  function buildHref(overrides: Record<string, string | null>) {
    const current: Record<string, string | null> = {
      status: activeStatus !== "all" ? activeStatus : null,
      tag: activeTag,
      board: activeBoard,
      grade: activeGrade,
      subject: activeSubject,
      medium: activeMedium,
      topic: activeTopic,
      page: activePage > 1 ? String(activePage) : null,
    };
    const merged = { ...current, ...overrides };
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) {
      if (value) params.set(key, value);
    }
    const qs = params.toString();
    return qs ? `/admin/answer-bank?${qs}` : "/admin/answer-bank";
  }

  const hasScopeFilter = Boolean(activeBoard || activeGrade || activeSubject || activeMedium || activeTopic);

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
            href={buildHref({ status: f.value === "all" ? null : f.value, page: null })}
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
        <select
          name="board"
          defaultValue={activeBoard ?? ""}
          className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">Any board</option>
          {(boards ?? []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <select
          name="grade"
          defaultValue={activeGrade ?? ""}
          className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">Any grade</option>
          {(grades ?? []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <select
          name="subject"
          defaultValue={activeSubject ?? ""}
          className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">Any subject</option>
          {(subjects ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          name="medium"
          defaultValue={activeMedium ?? ""}
          className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">Any medium</option>
          {MEDIUMS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        {activeBoard && activeGrade && activeSubject && activeMedium && (
          <select
            name="topic"
            defaultValue={activeTopic ?? ""}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">Any topic</option>
            {(filterTopics ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.chapter} — {t.topic}
              </option>
            ))}
          </select>
        )}
        <button className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-brand/5">
          Filter
        </button>
        {(activeTag || hasScopeFilter) && (
          <a
            href={buildHref({
              tag: null,
              board: null,
              grade: null,
              subject: null,
              medium: null,
              topic: null,
              page: null,
            })}
            className="text-xs text-foreground/50 hover:underline"
          >
            Clear filters
          </a>
        )}
      </form>

      <div className="mt-6 space-y-3">
        {rows.map((row) => {
          const board = (row as unknown as { boards: { name: string } | null }).boards;
          const grade = (row as unknown as { grades: { name: string } | null }).grades;
          const subject = (row as unknown as { subjects: { name: string } | null }).subjects;
          const topic = (row as unknown as { syllabus_topics: { chapter: string; topic: string } | null })
            .syllabus_topics;
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
                {topic && (
                  <>
                    <span>&middot;</span>
                    <span title="Syllabus topic this entry is scoped to">
                      {topic.chapter} — {topic.topic}
                    </span>
                  </>
                )}
              </div>
              <p className="mt-2 text-sm font-medium">
                <MathText text={row.question} />
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/70">
                <MathText text={row.answer} />
              </p>

              <div className="mt-3 space-y-2">
                {row.image_urls.length > 0 && (
                  <div className="flex flex-wrap items-start gap-2">
                    {row.image_urls.map((url) => (
                      <div key={url} className="flex flex-col items-center gap-1">
                        {/* eslint-disable-next-line @next/next/no-img-element -- external Supabase Storage URL, not a local/optimizable asset */}
                        <img
                          src={url}
                          alt="Attached figure for this question"
                          className="h-24 w-24 rounded-lg border border-border object-cover"
                        />
                        <form action={removeImage.bind(null, row.id, url)}>
                          <button type="submit" className="text-xs text-foreground/50 hover:underline">
                            Remove
                          </button>
                        </form>
                      </div>
                    ))}
                  </div>
                )}
                <form
                  action={addImage.bind(null, row.id)}
                  encType="multipart/form-data"
                  className="flex items-center gap-2"
                >
                  <input
                    type="file"
                    name="image"
                    accept="image/jpeg,image/png,image/gif,image/webp"
                    className="text-xs text-foreground/60"
                  />
                  <button
                    type="submit"
                    className="rounded-lg border border-border px-2 py-1 text-xs font-medium hover:bg-brand/5"
                  >
                    {row.image_urls.length > 0 ? "Add another image" : "Add image"}
                  </button>
                </form>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {row.tags.map((t) => (
                  <span
                    key={t}
                    className="flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-xs text-brand"
                  >
                    <a href={buildHref({ tag: t, page: null })} className="hover:underline">
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
        {rows.length === 0 && (
          <p className="text-sm text-foreground/50">No entries yet for this filter.</p>
        )}
      </div>

      {(activePage > 1 || hasNextPage) && (
        <div className="mt-4 flex items-center justify-between text-sm">
          {activePage > 1 ? (
            <a
              href={buildHref({ page: activePage - 1 > 1 ? String(activePage - 1) : null })}
              className="rounded-lg border border-border px-3 py-1.5 font-medium hover:bg-brand/5"
            >
              ← Previous
            </a>
          ) : (
            <span />
          )}
          <span className="text-foreground/50">Page {activePage}</span>
          {hasNextPage ? (
            <a
              href={buildHref({ page: String(activePage + 1) })}
              className="rounded-lg border border-border px-3 py-1.5 font-medium hover:bg-brand/5"
            >
              Next →
            </a>
          ) : (
            <span />
          )}
        </div>
      )}

      <BulkImportForm boards={boards ?? []} grades={grades ?? []} subjects={subjects ?? []} />
    </div>
  );
}
