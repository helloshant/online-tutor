"use client";

import { useState } from "react";
import type { AnswerFeedbackKind, AnswerFeedbackRating } from "@/lib/supabase/types";

// A quiet 👍/👎 on any LLM-generated answer the student is looking at --
// the one thing the review-gate model (topic_summaries/answered_questions'
// validation_status) never covered: a *live* reaction from the person the
// answer was actually for, right when they're looking at it, not just an
// admin's judgment before it gets reused. See 0031_answer_feedback.sql and
// /api/feedback/route.ts.
//
// contentSnapshot is exactly what's rendered on screen right now -- the
// full answer text, captured client-side rather than re-derived server-side
// from a row that (for a topic summary or exercise) might not exist as a
// stable, individually-addressable row at all by the time an admin looks at
// this feedback later.
export function FeedbackButtons({
  kind,
  targetId,
  subjectId,
  question,
  contentSnapshot,
}: {
  kind: AnswerFeedbackKind;
  // A chat_messages.id or a syllabus_topics.id -- see the migration's
  // comment on why this can't be a precise row reference for topic_summary/
  // exercise. Omitted entirely for a single exercise out of a batch: unlike
  // a topic (one summary shown at a time) or a chat message (always its own
  // row), several exercises share one topic, so a shared topic id here
  // would make giving feedback on exercise #2 silently delete separate
  // feedback already given on exercise #4 (see the dedup-by-target_id logic
  // in /api/feedback/route.ts) -- worse than the alternative (a repeat vote
  // on the exact same exercise just adds another row instead of replacing
  // it, which is harmless).
  targetId?: string;
  subjectId?: string | null;
  question?: string | null;
  contentSnapshot: string;
}) {
  const [rating, setRating] = useState<AnswerFeedbackRating | null>(null);
  const [showNoteField, setShowNoteField] = useState(false);
  const [note, setNote] = useState("");
  const [noteSent, setNoteSent] = useState(false);

  async function send(nextRating: AnswerFeedbackRating, noteText?: string) {
    setRating(nextRating);
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          targetId,
          subjectId,
          question,
          contentSnapshot,
          rating: nextRating,
          note: noteText,
        }),
      });
    } catch {
      // Best-effort -- a failed feedback POST shouldn't interrupt or error
      // out anything else on screen; the buttons still reflect the click.
    }
  }

  function handleThumb(next: AnswerFeedbackRating) {
    // A 👎 offers an optional note before/after recording -- a 👍 needs no
    // further input, there's nothing to explain about a right answer.
    if (next === "down") setShowNoteField(true);
    void send(next);
  }

  function submitNote() {
    setNoteSent(true);
    void send("down", note.trim() || undefined);
  }

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-foreground/40">
      <button
        type="button"
        onClick={() => handleThumb("up")}
        aria-pressed={rating === "up"}
        aria-label="This answer was helpful"
        title="This answer was helpful"
        className={`rounded px-1 py-0.5 transition hover:bg-brand/10 ${rating === "up" ? "text-brand" : ""}`}
      >
        👍
      </button>
      <button
        type="button"
        onClick={() => handleThumb("down")}
        aria-pressed={rating === "down"}
        aria-label="This answer wasn't right"
        title="This answer wasn't right"
        className={`rounded px-1 py-0.5 transition hover:bg-brand/10 ${rating === "down" ? "text-red-600" : ""}`}
      >
        👎
      </button>
      {rating === "up" && <span>Thanks!</span>}
      {rating === "down" && !showNoteField && <span>Thanks -- flagged for review.</span>}
      {showNoteField && !noteSent && (
        <div className="flex w-full items-center gap-1.5">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What was wrong? (optional)"
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
          />
          <button
            type="button"
            onClick={submitNote}
            className="shrink-0 rounded border border-border px-2 py-1 text-xs font-medium hover:bg-brand/5"
          >
            Send
          </button>
        </div>
      )}
      {noteSent && <span>Thanks -- flagged for review.</span>}
    </div>
  );
}
