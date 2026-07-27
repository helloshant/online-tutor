"use client";

import { useEffect, useState } from "react";
import type { SyllabusTopic } from "@/lib/supabase/types";

type ExerciseItem = { question: string; answer: string };

// Rendered as a message bubble inside the chat timeline (see chat-panel.tsx)
// rather than a separate panel or modal -- clicking a syllabus topic drops
// its summary straight into the conversation so a student can immediately
// ask the tutor a follow-up about it in the same view.
export function TopicSummaryMessage({ topic }: { topic: SyllabusTopic }) {
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(true);

  const [exercises, setExercises] = useState<ExerciseItem[] | null>(null);
  const [exercisesError, setExercisesError] = useState<string | null>(null);
  const [loadingExercises, setLoadingExercises] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/topics/${topic.id}/summary`);
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !body?.summary) {
          setSummaryError(body?.error ?? "Could not load the summary.");
          return;
        }
        setSummary(body.summary);
      } catch {
        if (!cancelled) setSummaryError("Could not load the summary.");
      } finally {
        if (!cancelled) setLoadingSummary(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [topic.id]);

  async function handleLoadExercises() {
    setLoadingExercises(true);
    setExercisesError(null);
    try {
      const res = await fetch(`/api/topics/${topic.id}/exercises`);
      const body = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(body?.exercises)) {
        setExercisesError(body?.error ?? "Could not load exercises.");
        return;
      }
      setExercises(body.exercises);
    } catch {
      setExercisesError("Could not load exercises.");
    } finally {
      setLoadingExercises(false);
    }
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] space-y-3 rounded-2xl border border-border bg-surface px-4 py-3 text-sm">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-foreground/40">{topic.chapter}</p>
          <p className="font-semibold">{topic.topic}</p>
        </div>

        {loadingSummary ? (
          <p className="text-foreground/50">Generating summary…</p>
        ) : summaryError ? (
          <p className="text-red-600">{summaryError}</p>
        ) : (
          <p className="whitespace-pre-wrap text-foreground/80">{summary}</p>
        )}

        {!loadingSummary && !summaryError && (
          <div className="border-t border-border pt-3">
            {exercisesError && <p className="mb-2 text-red-600">{exercisesError}</p>}

            {exercises === null ? (
              <button
                type="button"
                onClick={handleLoadExercises}
                disabled={loadingExercises}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-brand/5 disabled:opacity-60"
              >
                {loadingExercises ? "Finding exercises…" : "Relevant Exercises"}
              </button>
            ) : exercises.length === 0 ? (
              <p className="text-foreground/50">No exercises available for this topic yet.</p>
            ) : (
              <>
                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-foreground/40">
                  Relevant exercises
                </p>
                <ol className="space-y-4">
                  {exercises.map((ex, i) => (
                    <li key={i}>
                      <p className="font-medium">
                        {i + 1}. {ex.question}
                      </p>
                      <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-background p-3 text-foreground/80">
                        {ex.answer}
                      </p>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
