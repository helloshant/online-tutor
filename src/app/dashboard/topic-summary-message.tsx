"use client";

import { useEffect, useState } from "react";
import { MathText } from "@/components/math-text";
import type { SyllabusTopic } from "@/lib/supabase/types";

type ExerciseItem = { question: string; answer: string };

// Rendered as a message bubble inside the chat timeline (see chat-panel.tsx)
// rather than a separate panel or modal -- clicking a syllabus topic drops
// its summary straight into the conversation so a student can immediately
// ask the tutor a follow-up about it in the same view.
//
// preferEnglish is ChatPanel's language toggle, read at the moment this
// component mounts (a fresh mount per topic click -- see dashboard-shell.tsx's
// fresh clickId per click) rather than reacted to afterward: like an
// already-sent chat message, an already-shown summary doesn't retroactively
// change language just because the toggle moved on to something else.
export function TopicSummaryMessage({ topic, preferEnglish }: { topic: SyllabusTopic; preferEnglish: boolean }) {
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(true);

  const [exercises, setExercises] = useState<ExerciseItem[] | null>(null);
  const [exercisesError, setExercisesError] = useState<string | null>(null);
  const [loadingExercises, setLoadingExercises] = useState(false);

  // Tags actually present among this topic's own banked entries (an admin
  // has to have tagged a topic-scoped entry for any of this to show up --
  // see addTag in admin/answer-bank/actions.ts) -- offered as a way to
  // narrow the topic's exercises down further, e.g. "just the ones from
  // Ganit Prakash," without leaving the chat timeline for the full Practice
  // panel search.
  const [topicTags, setTopicTags] = useState<string[]>([]);
  const [activeTagFilter, setActiveTagFilter] = useState<string | null>(null);
  const [filteredExercises, setFilteredExercises] = useState<ExerciseItem[] | null>(null);
  const [loadingFilter, setLoadingFilter] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/topics/${topic.id}/summary?preferEnglish=${preferEnglish}`);
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
    // preferEnglish deliberately excluded -- see the component doc comment
    // above, this effect should only ever run once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic.id]);

  async function handleLoadExercises() {
    setLoadingExercises(true);
    setExercisesError(null);
    try {
      const res = await fetch(`/api/topics/${topic.id}/exercises?preferEnglish=${preferEnglish}`);
      const body = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(body?.exercises)) {
        setExercisesError(body?.error ?? "Could not load exercises.");
        return;
      }
      setExercises(body.exercises);

      // Best-effort -- if this fails, the tag-refine chips just don't show,
      // no error surfaced (the exercises themselves loaded fine).
      const tagsRes = await fetch(
        `/api/answer-bank/tags?subjectId=${encodeURIComponent(topic.subject_id)}&topicId=${encodeURIComponent(topic.id)}`
      );
      const tagsBody = await tagsRes.json().catch(() => null);
      if (tagsRes.ok && Array.isArray(tagsBody?.tags)) {
        setTopicTags(tagsBody.tags);
      }
    } catch {
      setExercisesError("Could not load exercises.");
    } finally {
      setLoadingExercises(false);
    }
  }

  async function handleFilterByTag(tag: string) {
    setLoadingFilter(true);
    setActiveTagFilter(tag);
    try {
      const res = await fetch(
        `/api/answer-bank/search?subjectId=${encodeURIComponent(topic.subject_id)}&topicId=${encodeURIComponent(topic.id)}&tag=${encodeURIComponent(tag)}`
      );
      const body = await res.json().catch(() => null);
      setFilteredExercises(res.ok && Array.isArray(body?.results) ? body.results : []);
    } catch {
      setFilteredExercises([]);
    } finally {
      setLoadingFilter(false);
    }
  }

  function clearTagFilter() {
    setActiveTagFilter(null);
    setFilteredExercises(null);
  }

  const displayedExercises = activeTagFilter ? filteredExercises : exercises;

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
          <p className="whitespace-pre-wrap text-foreground/80">
            <MathText text={summary ?? ""} />
          </p>
        )}

        {!loadingSummary && !summaryError && (
          <div className="border-t border-border pt-3">
            {exercisesError && <p className="mb-2 text-red-600">{exercisesError}</p>}

            {exercises === null ? (
              <button
                type="button"
                onClick={handleLoadExercises}
                disabled={loadingExercises}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {loadingExercises ? "Finding exercises…" : "Relevant Exercises"}
              </button>
            ) : (
              <>
                {topicTags.length > 0 && (
                  <div className="mb-3 flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-foreground/40">Refine by tag:</span>
                    {topicTags.map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => (activeTagFilter === t ? clearTagFilter() : handleFilterByTag(t))}
                        className={`rounded-full px-2 py-0.5 text-xs font-medium transition ${
                          activeTagFilter === t
                            ? "bg-brand text-white"
                            : "bg-brand/10 text-brand hover:bg-brand/20"
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                    {activeTagFilter && (
                      <button
                        type="button"
                        onClick={clearTagFilter}
                        className="text-xs text-foreground/40 hover:underline"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                )}

                {loadingFilter ? (
                  <p className="text-foreground/50">Filtering…</p>
                ) : displayedExercises === null || displayedExercises.length === 0 ? (
                  <p className="text-foreground/50">
                    {activeTagFilter
                      ? `No exercises tagged "${activeTagFilter}" for this topic.`
                      : "No exercises available for this topic yet."}
                  </p>
                ) : (
                  <>
                    <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-foreground/40">
                      {activeTagFilter ? `Relevant exercises — "${activeTagFilter}"` : "Relevant exercises"}
                    </p>
                    <ol className="space-y-4">
                      {displayedExercises.map((ex, i) => (
                        <li key={i}>
                          <p className="whitespace-pre-wrap font-medium">
                            {i + 1}. <MathText text={ex.question} />
                          </p>
                          <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-background p-3 text-foreground/80">
                            <MathText text={ex.answer} />
                          </p>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
