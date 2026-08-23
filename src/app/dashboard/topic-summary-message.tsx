"use client";

import { useEffect, useRef, useState } from "react";
import { MathText } from "@/components/math-text";
import { CitationText } from "@/components/citation-text";
import { LoadingIndicator } from "@/components/loading-indicator";
import { FeedbackButtons } from "@/components/feedback-buttons";
import type { SyllabusTopic } from "@/lib/supabase/types";

type ExerciseItem = { question: string; answer: string };

// Rendered as a message bubble inside the chat timeline (see chat-panel.tsx)
// rather than a separate panel or modal -- clicking a syllabus topic drops
// its summary straight into the conversation so a student can immediately
// ask the tutor a follow-up about it in the same view.
//
// preferEnglish is ChatPanel's language toggle. Unlike an ordinary sent chat
// message (an immutable historical record), this bubble is a live reference
// card for one topic -- flipping the toggle re-fetches the summary in place
// rather than only affecting the *next* topic clicked, since on mobile the
// toggle isn't even visible from the Topics tab a click originates from
// (it's up in ChatPanel's header, a different screen), and re-clicking an
// already-selected sidebar item to "try again" isn't a discoverable action.
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
      // Re-runs on a preferEnglish flip too (see the component doc comment
      // above) -- reset to the loading state rather than leaving the
      // previous language's text on screen while the new one comes in.
      setLoadingSummary(true);
      setSummaryError(null);
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
  }, [topic.id, preferEnglish]);

  // A language flip after exercises were already shown invalidates them --
  // reset to the "Relevant Exercises" button rather than silently
  // re-fetching in the background, consistent with exercises being an
  // explicit-action feature (unlike the summary above, which always loads
  // on its own). Skips the very first render (mount) since there's nothing
  // to invalidate yet -- exercises start out null already.
  const hasMountedRef = useRef(false);
  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    setExercises(null);
    setExercisesError(null);
    setTopicTags([]);
    setActiveTagFilter(null);
    setFilteredExercises(null);
  }, [preferEnglish]);

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
          <p className="text-foreground/50">
            <LoadingIndicator label="Generating summary…" />
          </p>
        ) : summaryError ? (
          <p className="text-red-600">{summaryError}</p>
        ) : (
          <>
            <p className="whitespace-pre-wrap text-foreground/80">
              <CitationText text={summary ?? ""} />
            </p>
            {/* target_id is the topic itself, not a topic_summaries row --
                see 0031_answer_feedback.sql's comment on why: a summary
                served straight from admin-authored chapter notes has no
                such row at all, and this is exactly what
                /admin/topic-summaries is itself keyed on. */}
            <FeedbackButtons
              kind="topic_summary"
              targetId={topic.id}
              subjectId={topic.subject_id}
              question={`${topic.chapter} / ${topic.topic}`}
              contentSnapshot={summary ?? ""}
            />
          </>
        )}

        {!loadingSummary && !summaryError && (
          <div className="border-t border-border pt-3">
            {exercisesError && <p className="mb-2 text-red-600">{exercisesError}</p>}

            {exercises === null ? (
              <>
                <button
                  type="button"
                  onClick={handleLoadExercises}
                  disabled={loadingExercises}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
                >
                  {loadingExercises ? "Finding exercises…" : "Relevant Exercises"}
                </button>
                {/* The lookup checks the answer bank first (instant) but falls
                    through to the LLM on a miss, which can take a few
                    seconds -- this makes that wait visible instead of just a
                    disabled button with no other feedback. */}
                {loadingExercises && (
                  <p className="mt-2 text-sm text-foreground/50">
                    <LoadingIndicator label="Asking the tutor for relevant exercises…" />
                  </p>
                )}
              </>
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
                          {/* No target_id -- several exercises share this one
                              topic and none has a stable per-instance row id
                              available here (see FeedbackButtons' own
                              comment on targetId); content_snapshot alone is
                              what tells this exercise apart from its
                              siblings for whoever reviews it. */}
                          <FeedbackButtons
                            kind="exercise"
                            subjectId={topic.subject_id}
                            question={`${topic.chapter} / ${topic.topic}`}
                            contentSnapshot={`Q: ${ex.question}\n\nA: ${ex.answer}`}
                          />
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
