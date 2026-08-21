"use client";

import { useEffect, useState } from "react";

type InboxItem = {
  recipientId: string;
  readAt: string | null;
  createdAt: string;
  broadcastId: string;
  type: "announcement" | "promotion" | "feedback" | "test";
  title: string;
  body: string;
};

const TYPE_LABELS: Record<InboxItem["type"], string> = {
  announcement: "Announcement",
  promotion: "Promotion",
  feedback: "Feedback",
  test: "Test",
};

// A student's broadcast inbox -- announcements/promotions (read-only),
// feedback requests (a 1-5 rating + optional comment), and tests (a real
// in-app MCQ/short-answer quiz, auto-graded where possible). Fetched once
// on mount rather than wired to `active` like PracticePanel's search does,
// since there's no per-keystroke cost to guard against here -- just one
// list fetch.
export function InboxPanel() {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/inbox");
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? "Could not load your inbox.");
        if (!cancelled) setItems(data.items);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load your inbox.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function handleSelect(item: InboxItem) {
    setSelectedId(item.recipientId);
    if (!item.readAt) {
      // Optimistic -- the unread dot disappears immediately rather than
      // waiting on the round trip, same reasoning chat-panel.tsx uses for
      // its own optimistic message bubble.
      setItems((prev) => prev?.map((i) => (i.recipientId === item.recipientId ? { ...i, readAt: new Date().toISOString() } : i)) ?? prev);
      void fetch(`/api/inbox/${item.recipientId}/read`, { method: "POST" });
    }
  }

  const selected = items?.find((i) => i.recipientId === selectedId) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden sm:flex-row">
      <div className={`min-h-0 overflow-y-auto border-border p-3 sm:w-72 sm:shrink-0 sm:border-r ${selected ? "hidden sm:block" : ""}`}>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground/40">Inbox</h2>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {items === null && !error && <p className="text-sm text-foreground/50">Loading…</p>}
        {items?.length === 0 && <p className="text-sm text-foreground/50">Nothing here yet.</p>}
        <ul className="space-y-1">
          {items?.map((item) => (
            <li key={item.recipientId}>
              <button
                type="button"
                onClick={() => handleSelect(item)}
                className={`block w-full rounded-lg px-3 py-2 text-left text-sm transition ${
                  item.recipientId === selectedId ? "bg-brand text-white" : "hover:bg-brand/5"
                }`}
              >
                <span className="flex items-center gap-1.5">
                  {!item.readAt && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" aria-label="Unread" />}
                  <span className={`truncate font-medium ${item.recipientId === selectedId ? "text-white" : ""}`}>{item.title}</span>
                </span>
                <span className={`block text-xs ${item.recipientId === selectedId ? "text-white/70" : "text-foreground/50"}`}>
                  {TYPE_LABELS[item.type]} · {new Date(item.createdAt).toLocaleDateString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!selected ? (
          <p className="text-sm text-foreground/50">Select an item from your inbox.</p>
        ) : (
          <div>
            <button type="button" onClick={() => setSelectedId(null)} className="mb-2 text-xs text-foreground/50 hover:underline sm:hidden">
              ← Inbox
            </button>
            <span className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">
              {TYPE_LABELS[selected.type]}
            </span>
            <h1 className="mt-1 text-base font-semibold">{selected.title}</h1>
            <p className="mt-2 max-w-2xl whitespace-pre-wrap text-sm text-foreground/80">{selected.body}</p>

            {selected.type === "feedback" && <FeedbackForm broadcastId={selected.broadcastId} />}
            {selected.type === "test" && <TestSection broadcastId={selected.broadcastId} />}
          </div>
        )}
      </div>
    </div>
  );
}

function FeedbackForm({ broadcastId }: { broadcastId: string }) {
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function handleSubmit() {
    setStatus("sending");
    try {
      const res = await fetch(`/api/broadcasts/${broadcastId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, comment: comment.trim() || null }),
      });
      if (!res.ok) throw new Error();
      setStatus("sent");
    } catch {
      setStatus("error");
    }
  }

  if (status === "sent") {
    return <p className="mt-4 text-sm text-green-600">Thanks -- your feedback was recorded.</p>;
  }

  return (
    <div className="mt-4 max-w-md space-y-2">
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setRating(n)}
            aria-label={`${n} star${n === 1 ? "" : "s"}`}
            className={`h-8 w-8 rounded-lg border text-sm font-medium transition ${
              rating !== null && n <= rating ? "border-brand bg-brand text-white" : "border-border text-foreground/50 hover:bg-brand/5"
            }`}
          >
            {n}
          </button>
        ))}
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Anything else you'd like to add (optional)"
        rows={3}
        className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
      />
      <button
        type="button"
        onClick={handleSubmit}
        disabled={status === "sending" || (rating === null && !comment.trim())}
        className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-60"
      >
        {status === "sending" ? "Sending…" : "Send feedback"}
      </button>
      {status === "error" && <p className="text-sm text-red-600">Could not send. Please try again.</p>}
    </div>
  );
}

type TestQuestion = {
  id: string;
  question_type: "mcq" | "short_answer";
  question: string;
  options: string[] | null;
  max_score: number;
  sort_order: number;
};
type TestAttempt = {
  id: string;
  status: "in_progress" | "submitted" | "graded";
  total_score: number | null;
  max_possible_score: number | null;
};
type ExistingAnswer = { question_id: string; selected_option: number | null; answer_text: string | null; score: number | null };

function TestSection({ broadcastId }: { broadcastId: string }) {
  const [loaded, setLoaded] = useState<{ attempt: TestAttempt; questions: TestQuestion[]; answers: ExistingAnswer[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [responses, setResponses] = useState<Record<string, { selectedOption?: number; answerText?: string }>>({});
  const [submitting, setSubmitting] = useState(false);

  async function loadTest() {
    setError(null);
    try {
      const res = await fetch(`/api/broadcasts/${broadcastId}/test`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not load the test.");
      setLoaded(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the test.");
    }
  }

  async function handleSubmit() {
    if (!loaded) return;
    setSubmitting(true);
    setError(null);
    try {
      const answers = loaded.questions.map((q) => ({ questionId: q.id, ...responses[q.id] }));
      const res = await fetch(`/api/broadcasts/${broadcastId}/test/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not submit the test.");
      await loadTest();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit the test.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!loaded) {
    return (
      <div className="mt-4">
        <button
          type="button"
          onClick={loadTest}
          className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark"
        >
          Open test
        </button>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  const { attempt, questions, answers } = loaded;
  const answerByQuestion = new Map(answers.map((a) => [a.question_id, a]));
  const isSubmitted = attempt.status !== "in_progress";

  return (
    <div className="mt-4 max-w-xl space-y-4">
      {isSubmitted && (
        <p className="rounded-lg border border-border bg-surface p-2 text-sm">
          {attempt.status === "graded"
            ? `Score: ${attempt.total_score ?? 0}/${attempt.max_possible_score ?? 0}`
            : `Submitted -- ${attempt.total_score ?? 0}/${attempt.max_possible_score ?? 0} so far, awaiting grading on the rest.`}
        </p>
      )}
      {questions.map((q, i) => {
        const existing = answerByQuestion.get(q.id);
        return (
          <div key={q.id} className="rounded-lg border border-border bg-surface p-3 text-sm">
            <p className="font-medium">
              {i + 1}. {q.question} <span className="text-xs font-normal text-foreground/40">({q.max_score} pt)</span>
            </p>
            {q.question_type === "mcq" ? (
              <div className="mt-2 space-y-1">
                {(q.options ?? []).map((opt, idx) => (
                  <label key={idx} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name={q.id}
                      disabled={isSubmitted}
                      checked={isSubmitted ? existing?.selected_option === idx : responses[q.id]?.selectedOption === idx}
                      onChange={() => setResponses((prev) => ({ ...prev, [q.id]: { selectedOption: idx } }))}
                    />
                    {opt}
                  </label>
                ))}
              </div>
            ) : isSubmitted ? (
              <p className="mt-2 text-foreground/70">{existing?.answer_text || "(no answer)"}</p>
            ) : (
              <textarea
                rows={2}
                onChange={(e) => setResponses((prev) => ({ ...prev, [q.id]: { answerText: e.target.value } }))}
                className="mt-2 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
              />
            )}
            {isSubmitted && q.question_type === "short_answer" && existing?.score !== null && (
              <p className="mt-1 text-xs text-foreground/50">Scored {existing?.score}/{q.max_score}</p>
            )}
          </div>
        );
      })}
      {!isSubmitted && (
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-60"
        >
          {submitting ? "Submitting…" : "Submit test"}
        </button>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
