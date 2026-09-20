"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { MathText } from "@/components/math-text";
import { TableText } from "@/components/markdown-table";
import { LoadingIndicator } from "@/components/loading-indicator";
import { FeedbackButtons } from "@/components/feedback-buttons";
import { TopicPractice, type PracticeExerciseItem } from "./topic-practice";
import type { SyllabusTopic } from "@/lib/supabase/types";

// The primary "Relevant Exercises" path -- always has a real, stable
// answered_questions row id (see /v1/topic-exercises's own response
// shape), so these can be graded (see TopicPractice, which owns the whole
// grading flow). The tag-filter path (SearchExercise, further down)
// reuses a DIFFERENT endpoint (/api/answer-bank/search) that has no id in
// its response shape -- deliberately left showing its answer immediately,
// unchanged, rather than extending that endpoint too; see the render
// branch below.
type SearchExercise = { question: string; answer: string };

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
export function TopicSummaryMessage({
  topic,
  preferEnglish,
  onSummaryLoaded,
}: {
  topic: SyllabusTopic;
  preferEnglish: boolean;
  // Fired once the summary fetch settles (success or error), i.e. right
  // when this bubble grows from a small loading placeholder to its real,
  // often much taller, content. ChatPanel's own auto-scroll only re-runs
  // when its `timeline` array changes -- adding this bubble fires it once,
  // at the placeholder's height, but the fetch here that swaps in the
  // actual summary is internal state a parent effect has no way to see.
  // Observed directly: the chat window would stop short of a summary's
  // real bottom, having already auto-scrolled before there was anything
  // there to scroll to. Optional so this component still works standalone
  // (e.g. in isolation/tests) without a parent wired up to it.
  //
  // Also hands back the loaded summary text itself (null on a failed
  // fetch) -- ChatPanel stores it on this bubble's own timeline entry so a
  // follow-up question can be sent with real context about what was just
  // shown (see chat-panel.tsx's handleTopicSummaryLoaded and
  // /api/chat/route.ts's parseTopicContext).
  onSummaryLoaded?: (summary: string | null) => void;
}) {
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(true);

  // "Relevant Exercises" no longer jumps straight to this topic's own
  // exercises -- it first lists every OTHER topic sharing this topic's
  // `chapter` (same board/grade/subject/medium too), so a student browsing
  // e.g. one story in "Sahitya Onushilon" can get exercises for any of the
  // book's other stories without leaving this bubble or going back to the
  // sidebar. null = list not requested yet (still showing the button);
  // an array (possibly just this one topic, for a chapter with nothing
  // else in it) once loaded. Fetched with the same direct Supabase read
  // TopicList uses for the sidebar itself, filtered down to this one
  // chapter -- no new API route needed for it.
  const [chapterTopics, setChapterTopics] = useState<SyllabusTopic[] | null>(
    null,
  );
  const [loadingChapterTopics, setLoadingChapterTopics] = useState(false);
  const [chapterTopicsError, setChapterTopicsError] = useState<string | null>(
    null,
  );

  // Which of chapterTopics a student has drilled into -- null means the
  // list above is still what's showing. Deliberately the whole row, not
  // just an id: TopicPractice/FeedbackButtons need this topic's own
  // `chapter`/`topic` label text, and every sibling already carries that
  // from the chapterTopics fetch, so there's no reason to look it back up.
  // Exercises stay inline under the list rather than swapping this
  // bubble's own summary/heading above -- picking a sibling here is a
  // quick "show me practice for X" glance, not the same as clicking X in
  // the sidebar itself.
  const [selectedExerciseTopic, setSelectedExerciseTopic] =
    useState<SyllabusTopic | null>(null);

  const [exercises, setExercises] = useState<PracticeExerciseItem[] | null>(
    null,
  );
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
  const [filteredExercises, setFilteredExercises] = useState<
    SearchExercise[] | null
  >(null);
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
        const res = await fetch(
          `/api/topics/${topic.id}/summary?preferEnglish=${preferEnglish}`,
        );
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

  // Fires onSummaryLoaded once the placeholder-to-real-content swap above
  // has actually committed to the DOM (an effect, not called inline in the
  // fetch itself, specifically so it runs after React has re-rendered with
  // the new height -- calling it synchronously alongside setLoadingSummary
  // would fire before that commit, which is exactly the "asked too early"
  // problem this exists to fix in the first place). Boxed in a ref so a
  // new inline callback identity from the parent on every render doesn't
  // also re-fire this -- only an actual loadingSummary transition should.
  const onSummaryLoadedRef = useRef(onSummaryLoaded);
  useEffect(() => {
    onSummaryLoadedRef.current = onSummaryLoaded;
  });
  useEffect(() => {
    // `summary`/`summaryError` are read here, not listed as deps -- both
    // settle in the same batched update as loadingSummary turning false
    // (see the fetch effect above: setSummary/setSummaryError always run
    // before the finally block's setLoadingSummary(false)), so this effect
    // already sees their final values whenever it's `loadingSummary` itself
    // that changed. Depending on them too would double-fire this on the
    // (harmless but pointless) render where they first settle.
    //
    // Explicitly null on error, rather than just passing `summary` as-is:
    // a re-fetch (preferEnglish flip) never resets `summary` back to null
    // before it runs, so a fetch that fails on its second-or-later attempt
    // would otherwise report the PREVIOUS language's stale summary text as
    // if it had just loaded successfully, even while the UI itself is
    // showing summaryError instead of it.
    if (!loadingSummary)
      onSummaryLoadedRef.current?.(summaryError ? null : summary);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingSummary]);

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
    setChapterTopics(null);
    setChapterTopicsError(null);
    setSelectedExerciseTopic(null);
    setExercises(null);
    setExercisesError(null);
    setTopicTags([]);
    setActiveTagFilter(null);
    setFilteredExercises(null);
  }, [preferEnglish]);

  async function handleLoadChapterTopics() {
    setLoadingChapterTopics(true);
    setChapterTopicsError(null);
    try {
      const supabase = createClient();

      // `chapter` doubles as two different things depending on the
      // subject, and only one of them is worth a sibling picker. For
      // subjects with real books/chapters (Bengali's "Sahitya Onushilon",
      // English's "Realm", Maths' "Ganit Prakash"...), `chapter` genuinely
      // groups several distinct lesson-topics, and browsing siblings is
      // useful. But for Physics/Chemistry/Maths/Biology-style subjects,
      // every topic instead carries `chapter` equal to the SUBJECT's own
      // name (confirmed directly against the data: this is a deliberate,
      // board-wide convention for subjects whose syllabus has no separate
      // book/chapter layer -- each `topic` row already IS one full
      // textbook chapter, the finest grain that exists). Grouping "by
      // chapter" there would just re-list the entire subject's topic
      // index right back at the student -- observed directly as
      // confusing, not narrowing anything. So this checks the subject's
      // own name first and, on a match, skips the picker list entirely
      // and goes straight to this topic's own exercises, same as the
      // original single-topic behavior.
      const { data: subjectRow } = await supabase
        .from("subjects")
        .select("name")
        .eq("id", topic.subject_id)
        .maybeSingle();

      if (
        subjectRow?.name &&
        subjectRow.name.toLowerCase() === topic.chapter.toLowerCase()
      ) {
        setChapterTopics([topic]);
        handleSelectExerciseTopic(topic);
        return;
      }

      const { data, error } = await supabase
        .from("syllabus_topics")
        .select("*")
        .eq("board_id", topic.board_id)
        .eq("grade_id", topic.grade_id)
        .eq("subject_id", topic.subject_id)
        .eq("medium", topic.medium)
        .eq("chapter", topic.chapter)
        .order("sort_order");
      if (error || !data) {
        setChapterTopicsError("Could not load topics for this chapter.");
        return;
      }
      setChapterTopics(data);
    } catch {
      setChapterTopicsError("Could not load topics for this chapter.");
    } finally {
      setLoadingChapterTopics(false);
    }
  }

  // Parameterized on `target` rather than always this bubble's own `topic`
  // -- called both when a student picks a sibling from the chapter list
  // (see handleSelectExerciseTopic) and, indirectly, whenever that
  // selection needs re-fetching (a preferEnglish flip resets back to the
  // chapter list entirely, so no retry path needs this on the same target
  // twice).
  async function handleLoadExercises(target: SyllabusTopic) {
    setLoadingExercises(true);
    setExercisesError(null);
    try {
      const res = await fetch(
        `/api/topics/${target.id}/exercises?preferEnglish=${preferEnglish}`,
      );
      const body = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(body?.exercises)) {
        setExercisesError(body?.error ?? "Could not load exercises.");
        return;
      }
      setExercises(body.exercises);

      // Best-effort -- if this fails, the tag chips just don't show, no
      // error surfaced (the exercises themselves loaded fine). The pattern
      // picker fetches its own data independently -- see TopicPractice/
      // PatternPicker.
      const tagsRes = await fetch(
        `/api/answer-bank/tags?subjectId=${encodeURIComponent(target.subject_id)}&topicId=${encodeURIComponent(target.id)}`,
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

  function handleSelectExerciseTopic(target: SyllabusTopic) {
    setSelectedExerciseTopic(target);
    void handleLoadExercises(target);
  }

  // Drops back to the chapter's topic list without re-fetching it --
  // chapterTopics itself never goes stale mid-session (a preferEnglish
  // flip already clears it separately, above), so there's nothing to
  // re-request, only this one topic's own exercise state to clear.
  function handleBackToChapterTopics() {
    setSelectedExerciseTopic(null);
    setExercises(null);
    setExercisesError(null);
    setTopicTags([]);
    setActiveTagFilter(null);
    setFilteredExercises(null);
  }

  async function handleFilterByTag(tag: string) {
    if (!selectedExerciseTopic) return;
    setLoadingFilter(true);
    setActiveTagFilter(tag);
    try {
      const res = await fetch(
        `/api/answer-bank/search?subjectId=${encodeURIComponent(selectedExerciseTopic.subject_id)}&topicId=${encodeURIComponent(selectedExerciseTopic.id)}&tag=${encodeURIComponent(tag)}`,
      );
      const body = await res.json().catch(() => null);
      setFilteredExercises(
        res.ok && Array.isArray(body?.results) ? body.results : [],
      );
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

  return (
    <div className="flex justify-start">
      {/* Full width of the chat column, not a fraction of it (80% then 95%
          both still read as "using half the screen" -- any percentage
          leaves a visible gap that scales with how wide the column already
          is, so the actual fix is not capping this at all). A topic
          summary is a reference card, not a chat exchange -- unlike an
          ordinary chat bubble (chat-panel.tsx, still max-w-[80%] and
          deliberately left that way), there's no conversational reason for
          it to sit narrower than the space it has. */}
      <div className="w-full space-y-3 rounded-2xl border border-border bg-surface px-4 py-3 text-sm">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-foreground/40">
            {topic.chapter}
          </p>
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
              <TableText text={summary ?? ""} />
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
            {chapterTopicsError && (
              <p className="mb-2 text-red-600">{chapterTopicsError}</p>
            )}

            {chapterTopics === null ? (
              <>
                <button
                  type="button"
                  onClick={handleLoadChapterTopics}
                  disabled={loadingChapterTopics}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
                >
                  {loadingChapterTopics
                    ? "Finding topics…"
                    : "Relevant Exercises"}
                </button>
                {loadingChapterTopics && (
                  <p className="mt-2 text-sm text-foreground/50">
                    <LoadingIndicator label="Loading topics for this chapter…" />
                  </p>
                )}
              </>
            ) : selectedExerciseTopic === null ? (
              <>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground/40">
                  {topic.chapter} — pick a topic for exercises
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {chapterTopics.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => handleSelectExerciseTopic(t)}
                      className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                        t.id === topic.id
                          ? "bg-brand/10 text-brand hover:bg-brand/20"
                          : "bg-foreground/10 text-foreground/70 hover:bg-foreground/20"
                      }`}
                    >
                      {t.topic}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-foreground/40">
                    Exercises — {selectedExerciseTopic.topic}
                  </p>
                  {/* Omitted when chapterTopics only ever held this one
                      topic (the flat-subject skip-the-picker case above --
                      "back" there would just lead to a one-item dead end,
                      not a real list to browse). */}
                  {chapterTopics && chapterTopics.length > 1 && (
                    <button
                      type="button"
                      onClick={handleBackToChapterTopics}
                      className="shrink-0 text-xs text-foreground/40 hover:underline"
                    >
                      ← All topics in this chapter
                    </button>
                  )}
                </div>

                {exercisesError && (
                  <p className="mb-2 text-red-600">{exercisesError}</p>
                )}

                {/* The lookup checks the answer bank first (instant) but falls
                    through to the LLM on a miss, which can take a few
                    seconds -- this makes that wait visible instead of just a
                    silent gap while exercises is still null. */}
                {exercises === null && loadingExercises ? (
                  <p className="text-sm text-foreground/50">
                    <LoadingIndicator label="Asking the tutor for relevant exercises…" />
                  </p>
                ) : exercises === null ? null : (
                  <>
                    {topicTags.length > 0 && (
                      <div className="mb-3 flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-foreground/40">
                          Refine by tag:
                        </span>
                        {topicTags.map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() =>
                              activeTagFilter === t
                                ? clearTagFilter()
                                : handleFilterByTag(t)
                            }
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
                    ) : activeTagFilter ? (
                      // Tag-filtered results come from a different endpoint
                      // (/api/answer-bank/search) with no stable id in its
                      // response shape -- shown immediately, same as before
                      // the grading flow existed, rather than extending that
                      // endpoint too. See SearchExercise's own comment.
                      filteredExercises === null ||
                      filteredExercises.length === 0 ? (
                        <p className="text-foreground/50">
                          No exercises tagged &quot;{activeTagFilter}&quot; for
                          this topic.
                        </p>
                      ) : (
                        <>
                          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-foreground/40">
                            Relevant exercises — &quot;{activeTagFilter}&quot;
                          </p>
                          <ol className="space-y-4">
                            {filteredExercises.map((ex, i) => (
                              <li key={i}>
                                <p className="whitespace-pre-wrap font-medium">
                                  {i + 1}. <MathText text={ex.question} />
                                </p>
                                <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-background p-3 text-foreground/80">
                                  <MathText text={ex.answer} />
                                </p>
                                {/* No target_id -- several exercises share this one
                                topic and this path has no stable per-instance
                                row id available here (see FeedbackButtons' own
                                comment on targetId); content_snapshot alone is
                                what tells this exercise apart from its
                                siblings for whoever reviews it. */}
                                <FeedbackButtons
                                  kind="exercise"
                                  subjectId={selectedExerciseTopic.subject_id}
                                  question={`${selectedExerciseTopic.chapter} / ${selectedExerciseTopic.topic}`}
                                  contentSnapshot={`Q: ${ex.question}\n\nA: ${ex.answer}`}
                                />
                              </li>
                            ))}
                          </ol>
                        </>
                      )
                    ) : (
                      <TopicPractice
                        topicId={selectedExerciseTopic.id}
                        subjectId={selectedExerciseTopic.subject_id}
                        chapter={selectedExerciseTopic.chapter}
                        topic={selectedExerciseTopic.topic}
                        preferEnglish={preferEnglish}
                        initialExercises={exercises}
                        emptyLabel="No exercises available for this topic yet."
                      />
                    )}
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
