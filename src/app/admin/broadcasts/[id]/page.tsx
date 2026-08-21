import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import type { BroadcastType } from "@/lib/supabase/types";
import { QuestionForm } from "./question-form";
import { deleteTestQuestion, gradeShortAnswer, sendBroadcastAction } from "../actions";

const TYPE_LABELS: Record<BroadcastType, string> = {
  announcement: "Announcement",
  promotion: "Promotion",
  feedback: "Feedback request",
  test: "Test",
};

type QuestionRow = {
  id: string;
  question_type: "mcq" | "short_answer";
  question: string;
  options: string[] | null;
  correct_option: number | null;
  max_score: number;
  sort_order: number;
};

export default async function BroadcastDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminPage("broadcasts");
  const { id } = await params;

  const supabase = createAdminClient();
  const { data: broadcast } = await supabase
    .from("broadcasts")
    .select("*, boards(name), grades(name), subjects(name)")
    .eq("id", id)
    .maybeSingle();
  if (!broadcast) notFound();

  const scope = broadcast as unknown as {
    boards: { name: string } | null;
    grades: { name: string } | null;
    subjects: { name: string } | null;
  };

  const isDraft = broadcast.status === "draft";

  return (
    <div>
      <Link href="/admin/broadcasts" className="text-xs text-foreground/50 hover:underline">
        ← Broadcasts
      </Link>
      <div className="mt-1 flex items-center gap-2">
        <span className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">
          {TYPE_LABELS[broadcast.type as BroadcastType]}
        </span>
        <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-xs font-medium text-foreground/60">
          {broadcast.status}
        </span>
        <h1 className="text-lg font-semibold">{broadcast.title}</h1>
      </div>
      <p className="mt-1 text-xs text-foreground/50">
        {[scope.boards?.name ?? "All boards", scope.grades?.name ?? "All grades", scope.subjects?.name ?? "All subjects", broadcast.medium ?? "All mediums"].join(" · ")}
      </p>
      <p className="mt-3 max-w-2xl whitespace-pre-wrap rounded-xl border border-border bg-surface p-3 text-sm">
        {broadcast.body}
      </p>

      {broadcast.type === "test" && (
        <TestQuestionsSection broadcastId={id} isDraft={isDraft} />
      )}

      {isDraft ? (
        <form action={sendBroadcastAction.bind(null, id)} className="mt-4">
          <SendButton broadcastId={id} type={broadcast.type as BroadcastType} />
        </form>
      ) : (
        <ResultsSection broadcastId={id} type={broadcast.type as BroadcastType} />
      )}
    </div>
  );
}

async function SendButton({ broadcastId, type }: { broadcastId: string; type: BroadcastType }) {
  let disabled = false;
  let hint: string | null = null;
  if (type === "test") {
    const supabase = createAdminClient();
    const { count } = await supabase
      .from("test_questions")
      .select("id", { count: "exact", head: true })
      .eq("broadcast_id", broadcastId);
    if (!count) {
      disabled = true;
      hint = "Add at least one question before sending.";
    }
  }
  return (
    <div>
      <button
        disabled={disabled}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
      >
        Send now
      </button>
      {hint && <p className="mt-1 text-xs text-foreground/50">{hint}</p>}
    </div>
  );
}

async function TestQuestionsSection({ broadcastId, isDraft }: { broadcastId: string; isDraft: boolean }) {
  const supabase = createAdminClient();
  const { data: questions } = await supabase
    .from("test_questions")
    .select("id, question_type, question, options, correct_option, max_score, sort_order")
    .eq("broadcast_id", broadcastId)
    .order("sort_order");
  const rows = (questions ?? []) as QuestionRow[];

  return (
    <div className="mt-4">
      <h2 className="text-sm font-semibold">Questions</h2>
      <div className="mt-2 space-y-2">
        {rows.length === 0 && <p className="text-sm text-foreground/50">No questions yet.</p>}
        {rows.map((q, i) => (
          <div key={q.id} className="flex items-start justify-between gap-3 rounded-lg border border-border bg-surface p-3 text-sm">
            <div>
              <p className="font-medium">
                {i + 1}. {q.question} <span className="text-xs font-normal text-foreground/40">({q.max_score} pt)</span>
              </p>
              {q.question_type === "mcq" && q.options && (
                <ul className="mt-1 text-xs text-foreground/60">
                  {q.options.map((opt, idx) => (
                    <li key={idx} className={idx === q.correct_option ? "font-medium text-green-700" : undefined}>
                      {idx === q.correct_option ? "✓ " : "· "}
                      {opt}
                    </li>
                  ))}
                </ul>
              )}
              {q.question_type === "short_answer" && (
                <p className="mt-1 text-xs text-foreground/50">Short answer -- graded manually after submission.</p>
              )}
            </div>
            {isDraft && (
              <form action={deleteTestQuestion.bind(null, broadcastId, q.id)}>
                <button className="text-xs font-medium text-red-600 hover:underline">Delete</button>
              </form>
            )}
          </div>
        ))}
      </div>
      {isDraft && (
        <div className="mt-3">
          <QuestionForm broadcastId={broadcastId} />
        </div>
      )}
    </div>
  );
}

async function ResultsSection({ broadcastId, type }: { broadcastId: string; type: BroadcastType }) {
  const supabase = createAdminClient();

  const { count: recipientCount } = await supabase
    .from("broadcast_recipients")
    .select("id", { count: "exact", head: true })
    .eq("broadcast_id", broadcastId);
  const { count: readCount } = await supabase
    .from("broadcast_recipients")
    .select("id", { count: "exact", head: true })
    .eq("broadcast_id", broadcastId)
    .not("read_at", "is", null);

  return (
    <div className="mt-6">
      <h2 className="text-sm font-semibold">Reach</h2>
      <p className="mt-1 text-sm text-foreground/60">
        Sent to {recipientCount ?? 0} student{recipientCount === 1 ? "" : "s"} · read by {readCount ?? 0}
      </p>

      {type === "feedback" && <FeedbackResults broadcastId={broadcastId} />}
      {type === "test" && <TestResults broadcastId={broadcastId} />}
    </div>
  );
}

async function FeedbackResults({ broadcastId }: { broadcastId: string }) {
  const supabase = createAdminClient();
  const { data: responses } = await supabase
    .from("broadcast_feedback_responses")
    .select("user_id, rating, comment, created_at")
    .eq("broadcast_id", broadcastId)
    .order("created_at", { ascending: false });

  const rows = responses ?? [];
  // profiles, not auth.users -- broadcast_feedback_responses.user_id
  // references auth.users like every other user-reference column in this
  // app, so a name needs a separate lookup by id, same pattern
  // /admin/coupons uses for coupon_codes.used_by.
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const { data: users } =
    userIds.length > 0 ? await supabase.from("profiles").select("id, full_name").in("id", userIds) : { data: [] };
  const nameById = new Map((users ?? []).map((u) => [u.id, u.full_name]));

  const rated = rows.filter((r) => r.rating !== null);
  const avg = rated.length > 0 ? rated.reduce((sum, r) => sum + (r.rating ?? 0), 0) / rated.length : null;

  return (
    <div className="mt-4">
      <h2 className="text-sm font-semibold">
        Feedback ({rows.length}) {avg !== null && <span className="font-normal text-foreground/50">· avg {avg.toFixed(1)}/5</span>}
      </h2>
      <div className="mt-2 space-y-2">
        {rows.length === 0 && <p className="text-sm text-foreground/50">No responses yet.</p>}
        {rows.map((r, i) => (
          <div key={i} className="rounded-lg border border-border bg-surface p-3 text-sm">
            <p className="text-xs text-foreground/50">
              {nameById.get(r.user_id) ?? "Student"} · {r.rating ? `${r.rating}/5` : "no rating"} ·{" "}
              {new Date(r.created_at).toLocaleString()}
            </p>
            {r.comment && <p className="mt-1">{r.comment}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

async function TestResults({ broadcastId }: { broadcastId: string }) {
  const supabase = createAdminClient();
  const [{ data: attempts }, { data: questions }] = await Promise.all([
    supabase
      .from("test_attempts")
      .select("id, user_id, status, total_score, max_possible_score, submitted_at")
      .eq("broadcast_id", broadcastId)
      .order("submitted_at", { ascending: false, nullsFirst: false }),
    supabase.from("test_questions").select("id, question, max_score").eq("broadcast_id", broadcastId),
  ]);

  const attemptRows = attempts ?? [];
  const questionById = new Map((questions ?? []).map((q) => [q.id, q]));

  // profiles, not auth.users -- same reasoning as FeedbackResults above.
  const userIds = [...new Set(attemptRows.map((a) => a.user_id))];
  const { data: users } =
    userIds.length > 0 ? await supabase.from("profiles").select("id, full_name").in("id", userIds) : { data: [] };
  const nameById = new Map((users ?? []).map((u) => [u.id, u.full_name]));

  // Only fetched for attempts still awaiting a grade -- most attempts on
  // an all-MCQ test never need this query at all.
  const pendingAttemptIds = attemptRows.filter((a) => a.status === "submitted").map((a) => a.id);
  const { data: pendingAnswers } =
    pendingAttemptIds.length > 0
      ? await supabase
          .from("test_answers")
          .select("id, attempt_id, question_id, answer_text, score")
          .in("attempt_id", pendingAttemptIds)
          .is("score", null)
      : { data: [] as { id: string; attempt_id: string; question_id: string; answer_text: string | null; score: number | null }[] };

  const pendingByAttempt = new Map<string, typeof pendingAnswers>();
  for (const a of pendingAnswers ?? []) {
    const list = pendingByAttempt.get(a.attempt_id) ?? [];
    list.push(a);
    pendingByAttempt.set(a.attempt_id, list);
  }

  return (
    <div className="mt-4">
      <h2 className="text-sm font-semibold">Attempts ({attemptRows.length})</h2>
      <div className="mt-2 space-y-2">
        {attemptRows.length === 0 && <p className="text-sm text-foreground/50">No attempts yet.</p>}
        {attemptRows.map((a) => {
          const pending = pendingByAttempt.get(a.id) ?? [];
          return (
            <div key={a.id} className="rounded-lg border border-border bg-surface p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{nameById.get(a.user_id) ?? "Student"}</p>
                <span className="text-xs text-foreground/60">
                  {a.status === "graded"
                    ? `${a.total_score ?? 0}/${a.max_possible_score ?? 0}`
                    : `${a.total_score ?? 0}/${a.max_possible_score ?? 0} (awaiting grading)`}
                </span>
              </div>
              {pending.length > 0 && (
                <div className="mt-2 space-y-2 border-t border-border pt-2">
                  {pending.map((p) => {
                    const q = questionById.get(p.question_id);
                    return (
                      <div key={p.id}>
                        <p className="text-xs font-medium text-foreground/70">{q?.question}</p>
                        <p className="mt-0.5 whitespace-pre-wrap text-sm">{p.answer_text}</p>
                        <form action={gradeShortAnswer.bind(null, broadcastId, p.id)} className="mt-1 flex items-center gap-2">
                          <input
                            name="score"
                            type="number"
                            min="0"
                            max={q?.max_score ?? undefined}
                            step="0.5"
                            required
                            placeholder={`0-${q?.max_score ?? 1}`}
                            className="w-20 rounded-lg border border-border bg-background px-2 py-1 text-xs"
                          />
                          <button className="rounded-lg border border-brand px-2 py-1 text-xs font-medium text-brand hover:bg-brand/5">
                            Grade
                          </button>
                        </form>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
