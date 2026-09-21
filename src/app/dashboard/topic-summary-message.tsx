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

// Same local-mirror convention as SubtopicOption below -- see the
// orchestrator's own ExerciseType comment for the full reasoning. Powers
// the type picker shown next to the concept path's own "Generate more
// exercises" action (a real mined sub-topic gets an equivalent through
// PatternPicker's own type picker instead, see pattern-picker.tsx).
type ExerciseType = "MCQ" | "short_answer" | "long_answer" | "numerical";
const EXERCISE_TYPES: ExerciseType[] = [
  "MCQ",
  "short_answer",
  "long_answer",
  "numerical",
];
const EXERCISE_TYPE_LABELS: Record<ExerciseType, string> = {
  MCQ: "MCQ",
  short_answer: "Short answer",
  long_answer: "Long answer",
  numerical: "Numerical",
};

// Mirrors /api/topics/[id]/exercises/subtopics' own SubtopicOption shape --
// same "define a local mirror type on the client side" convention
// pattern-picker.tsx's own Pattern type already follows, rather than
// importing a type across the route-file boundary. A real, exam-mined
// sub-topic (CBSE today) or one of the chapter's own content-chunk
// concepts (the WBBSE/ICSE fallback) -- see that route's own comment on
// why these are two genuinely separate sources merged into one flat list.
type SubtopicOption =
  | { kind: "archetype"; name: string; questionCount: number }
  | { kind: "concept"; id: string; term: string };

// The synthetic "skip the sub-topic breakdown" pill always offered
// alongside any real ones, plus the value auto-selected when a chapter has
// no real sub-topic data at all (see handleSelectExerciseTopic) -- same
// flat, whole-chapter batch this app always showed before this feature
// existed.
type SubtopicSelection = SubtopicOption | { kind: "all" };

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

  // The selected topic's own sub-topic breakdown (see
  // /api/topics/[id]/exercises/subtopics) -- null while still loading
  // (right after a topic is picked above), an empty array for a chapter
  // with no real sub-topic data at all (in which case selectedSubtopic
  // below is set straight to {kind:"all"} and the picker below never
  // renders -- same flat behavior as before this feature existed).
  const [subtopics, setSubtopics] = useState<SubtopicOption[] | null>(null);
  const [loadingSubtopics, setLoadingSubtopics] = useState(false);
  // Which pill was clicked -- null means the pill row above is still what
  // should show (only possible when subtopics is non-empty; see
  // handleSelectExerciseTopic).
  const [selectedSubtopic, setSelectedSubtopic] =
    useState<SubtopicSelection | null>(null);

  const [exercises, setExercises] = useState<PracticeExerciseItem[] | null>(
    null,
  );
  const [exercisesError, setExercisesError] = useState<string | null>(null);
  const [loadingExercises, setLoadingExercises] = useState(false);
  // Only for the concept path's own "More practice on this concept" action (see
  // handleLoadConceptExercises' own `append` comment) -- a separate flag
  // from loadingExercises so this action's own button can show its own
  // busy state without also re-triggering the initial-load spinner, which
  // only checks `exercises === null` and would never see this since
  // exercises is already populated by the time this action is reachable.
  const [loadingMoreExercises, setLoadingMoreExercises] = useState(false);
  // Which type the concept path's own "More practice on this concept" button
  // should ask for next -- undefined means "Any" (today's mixed
  // behavior). Reported directly: there was no way to request a specific
  // type at all. Only meaningful once selectedSubtopic.kind === "concept"
  // (a real mined sub-topic gets the equivalent through PatternPicker's
  // own type picker instead), but kept as one piece of state regardless
  // rather than nested inside the subtopic union -- simpler to reset
  // alongside the other per-subtopic state below.
  const [conceptType, setConceptType] = useState<ExerciseType | undefined>(
    undefined,
  );

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
    setSubtopics(null);
    setSelectedSubtopic(null);
    setExercises(null);
    setExercisesError(null);
    setLoadingMoreExercises(false);
    setConceptType(undefined);
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
      // English's "Realm", Maths' "Ganit Prakash" in grades where it
      // genuinely spans several books...), `chapter` groups several
      // distinct lesson-topics UNDER MORE THAN ONE chapter value for the
      // subject, and browsing siblings within just one of them is useful.
      // But plenty of subjects instead give EVERY topic in the whole
      // subject the exact same `chapter` value -- most of CBSE/ICSE's own
      // Physics/Chemistry/Maths/Biology (that value equal to the subject's
      // own name), but also, confirmed directly against the data, WBBSE
      // Grade 10's entire catalogue across every subject, STEM and
      // humanities alike (that value instead a romanized book title, e.g.
      // Physical Science's "Bhoutobigyan O Poribesh") -- there `chapter`
      // is really just a board-wide catalogue tag, not a real narrowing
      // dimension, and grouping "by chapter" would just re-list the
      // entire subject's topic index right back at the student, exactly
      // the "displaying the same set of chapters doesn't make any sense"
      // bug already fixed once for CBSE Biology. A literal subject-name
      // string comparison (the original fix) only ever caught the first
      // of these two conventions -- this checks the real, board-agnostic
      // signal instead: does this subject have more than one DISTINCT
      // chapter value at all? A "no" is the useless case either way, so
      // this skips the picker list entirely and goes straight to this
      // topic's own exercises, same as the original single-topic
      // behavior; a "yes" narrows down to just this topic's own chapter,
      // same as before.
      const { data, error } = await supabase
        .from("syllabus_topics")
        .select("*")
        .eq("board_id", topic.board_id)
        .eq("grade_id", topic.grade_id)
        .eq("subject_id", topic.subject_id)
        .eq("medium", topic.medium)
        .order("sort_order");
      if (error || !data) {
        setChapterTopicsError("Could not load topics for this chapter.");
        return;
      }

      const distinctChapters = new Set(
        data.map((t) => t.chapter.toLowerCase()),
      );
      if (distinctChapters.size <= 1) {
        setChapterTopics([topic]);
        handleSelectExerciseTopic(topic);
        return;
      }

      setChapterTopics(data.filter((t) => t.chapter === topic.chapter));
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
  // twice). `subTopic`, when given, narrows generation to just that real
  // mined sub-topic (see the orchestrator's own TopicExercisesRequest
  // comment) -- omitted both for the flat "all exercises" pick and for the
  // auto-selected flat path when a chapter has no sub-topic data at all.
  async function handleLoadExercises(target: SyllabusTopic, subTopic?: string) {
    setLoadingExercises(true);
    setExercisesError(null);
    try {
      const params = new URLSearchParams({
        preferEnglish: String(preferEnglish),
      });
      if (subTopic) params.set("subTopic", subTopic);
      const res = await fetch(`/api/topics/${target.id}/exercises?${params}`);
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

  // Sibling of handleLoadExercises above, scoped to one of the chapter's
  // own content-chunk concepts (see the orchestrator's own
  // GenerateConceptExercisesRequest/generate-for-concept comments) rather
  // than a real mined sub-topic. No tag fetch here -- a concept-scoped
  // batch is always freshly generated (never banked, see that route's own
  // comment on why), so there's no accumulated admin-tagged set to offer a
  // "refine by tag" row for the way the other two paths have.
  //
  // `append`, when true, ADDS this fresh batch onto whatever's already
  // shown instead of replacing it -- used by the "More practice on this concept"
  // action below, which needs the earlier questions to stay put (a student
  // partway through grading them shouldn't lose their in-progress work).
  // The initial pill click still replaces (append defaults to false),
  // matching every other "pick a sub-topic" path here.
  async function handleLoadConceptExercises(
    target: SyllabusTopic,
    conceptId: string,
    append = false,
    // Only ever passed on an append call -- see the "Generate more
    // exercises" button's own comment for why this isn't offered on the
    // initial pill-click batch (mixed types there, same as before this
    // feature existed).
    requestedType?: ExerciseType,
  ) {
    if (append) setLoadingMoreExercises(true);
    else setLoadingExercises(true);
    setExercisesError(null);
    try {
      const params = new URLSearchParams({
        preferEnglish: String(preferEnglish),
        conceptId,
        ...(requestedType ? { requestedType } : {}),
      });
      const res = await fetch(
        `/api/topics/${target.id}/exercises/generate-for-concept?${params}`,
      );
      const body = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(body?.exercises)) {
        setExercisesError(body?.error ?? "Could not load exercises.");
        return;
      }
      // An empty array is a legitimate response (see generate-for-concept's
      // own comment: a stale picker, or a parse failure on this specific
      // attempt) rather than an error -- but silently leaving `exercises`
      // unchanged on `append` gave a student clicking "Generate more" NO
      // feedback at all: the button just went back to normal with nothing
      // added and nothing explained, indistinguishable from the click not
      // having registered. Surfaced explicitly so a real "nothing new this
      // time" reads as exactly that, not as a broken button.
      if (body.exercises.length === 0) {
        setExercisesError(
          append
            ? "Could not generate a new question this time -- try again."
            : "Could not load exercises.",
        );
        return;
      }
      setExercises((prev) =>
        append ? [...(prev ?? []), ...body.exercises] : body.exercises,
      );
    } catch {
      setExercisesError("Could not load exercises.");
    } finally {
      if (append) setLoadingMoreExercises(false);
      else setLoadingExercises(false);
    }
  }

  // Loads this topic's own sub-topic breakdown, then either shows the pill
  // row (real sub-topic data exists) or falls straight through to the flat
  // whole-chapter batch (none does) -- see subtopics' own comment. A
  // fetch failure is treated the same as "nothing to browse" rather than
  // surfaced as its own error: the flat batch is always a safe fallback,
  // and a broken sub-topic picker should never block exercises entirely.
  async function handleSelectExerciseTopic(target: SyllabusTopic) {
    setSelectedExerciseTopic(target);
    setSubtopics(null);
    setSelectedSubtopic(null);
    setExercises(null);
    setExercisesError(null);
    setLoadingMoreExercises(false);
    setConceptType(undefined);
    setTopicTags([]);
    setActiveTagFilter(null);
    setFilteredExercises(null);

    setLoadingSubtopics(true);
    try {
      const res = await fetch(`/api/topics/${target.id}/exercises/subtopics`);
      const body = await res.json().catch(() => null);
      const options: SubtopicOption[] =
        res.ok && Array.isArray(body?.subtopics) ? body.subtopics : [];
      setSubtopics(options);
      if (options.length === 0) {
        setSelectedSubtopic({ kind: "all" });
        void handleLoadExercises(target);
      }
    } catch {
      setSubtopics([]);
      setSelectedSubtopic({ kind: "all" });
      void handleLoadExercises(target);
    } finally {
      setLoadingSubtopics(false);
    }
  }

  function handleSelectSubtopic(
    target: SyllabusTopic,
    option: SubtopicSelection,
  ) {
    setSelectedSubtopic(option);
    setExercises(null);
    setExercisesError(null);
    setLoadingMoreExercises(false);
    setConceptType(undefined);
    setTopicTags([]);
    setActiveTagFilter(null);
    setFilteredExercises(null);

    if (option.kind === "all") void handleLoadExercises(target);
    else if (option.kind === "archetype")
      void handleLoadExercises(target, option.name);
    else void handleLoadConceptExercises(target, option.id);
  }

  // Drops back to the sub-topic pill row without re-fetching it --
  // subtopics itself never goes stale mid-session (a preferEnglish flip
  // already clears it separately, above), so there's nothing to
  // re-request, only this one sub-topic's own exercise state to clear.
  function handleBackToSubtopics() {
    setSelectedSubtopic(null);
    setExercises(null);
    setExercisesError(null);
    setLoadingMoreExercises(false);
    setConceptType(undefined);
    setTopicTags([]);
    setActiveTagFilter(null);
    setFilteredExercises(null);
  }

  // Drops back to the chapter's topic list without re-fetching it --
  // chapterTopics itself never goes stale mid-session (a preferEnglish
  // flip already clears it separately, above), so there's nothing to
  // re-request, only this one topic's own sub-topic/exercise state to
  // clear.
  function handleBackToChapterTopics() {
    setSelectedExerciseTopic(null);
    setSubtopics(null);
    setSelectedSubtopic(null);
    setExercises(null);
    setExercisesError(null);
    setLoadingMoreExercises(false);
    setConceptType(undefined);
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

                {loadingSubtopics ? (
                  <p className="text-sm text-foreground/50">
                    <LoadingIndicator label="Finding sub-topics…" />
                  </p>
                ) : subtopics === null ? null : selectedSubtopic === null ? (
                  // Only reachable when subtopics.length > 0 --
                  // handleSelectExerciseTopic auto-selects {kind:"all"} the
                  // moment subtopics comes back empty, skipping this pill
                  // row entirely (see its own comment).
                  <>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground/40">
                      {selectedExerciseTopic.topic} — pick a sub-topic
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {subtopics.map((s) => (
                        <button
                          key={
                            s.kind === "archetype"
                              ? `archetype:${s.name}`
                              : `concept:${s.id}`
                          }
                          type="button"
                          onClick={() =>
                            handleSelectSubtopic(selectedExerciseTopic, s)
                          }
                          className="rounded-full bg-brand/10 px-2.5 py-1 text-xs font-medium text-brand transition hover:bg-brand/20"
                        >
                          {s.kind === "archetype"
                            ? `${s.name}${s.questionCount > 0 ? ` (${s.questionCount})` : ""}`
                            : s.term}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() =>
                          handleSelectSubtopic(selectedExerciseTopic, {
                            kind: "all",
                          })
                        }
                        className="rounded-full bg-foreground/10 px-2.5 py-1 text-xs font-medium text-foreground/60 transition hover:bg-foreground/20"
                      >
                        All exercises for this chapter
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    {/* Only shown once a real pill was picked -- the
                        auto-selected flat path (subtopics came back empty)
                        has no picker to go back to. */}
                    {subtopics.length > 0 && (
                      <button
                        type="button"
                        onClick={handleBackToSubtopics}
                        className="mb-2 text-xs text-foreground/40 hover:underline"
                      >
                        ← Different sub-topic
                      </button>
                    )}

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
                              No exercises tagged &quot;{activeTagFilter}&quot;
                              for this topic.
                            </p>
                          ) : (
                            <>
                              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-foreground/40">
                                Relevant exercises — &quot;{activeTagFilter}
                                &quot;
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
                                      subjectId={
                                        selectedExerciseTopic.subject_id
                                      }
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
                            // Only a real mined sub-topic (kind:"archetype")
                            // narrows the pattern picker underneath -- a
                            // concept pick (kind:"concept") has no archetype
                            // data behind it at all (WBBSE/ICSE, see
                            // chunkConcepts.ts), and "all exercises for this
                            // chapter" (kind:"all") is deliberately unscoped,
                            // same as before this sub-topic feature existed.
                            subTopic={
                              selectedSubtopic?.kind === "archetype"
                                ? selectedSubtopic.name
                                : undefined
                            }
                            // Reported directly: for a concept pick,
                            // PatternPicker's own patterns are mined at the
                            // CHAPTER level, not the concept level -- there
                            // was no subTopic to scope it to (see the prop
                            // just above), so it showed every pattern for
                            // the whole chapter regardless of which concept
                            // was actually picked, stacked confusingly on
                            // top of that concept's own, correctly-scoped
                            // "More practice on this concept" + Type picker.
                            suppressPatternPicker={
                              selectedSubtopic?.kind === "concept"
                            }
                            initialExercises={exercises}
                            emptyLabel="No exercises available for this topic yet."
                          />
                        )}
                      </>
                    )}
                    {/* Repeats the top-of-panel back link (see above) once
                        more below the exercise list AND the pattern picker
                        -- without this, going back to a different sub-topic
                        after generating a few on-demand patterns meant
                        scrolling all the way back up past everything just
                        shown, the exact "no way back" report this fixes.
                        Same condition, same handler, just a second place to
                        reach it from. Reported directly again even with
                        this in place: a plain faint text link blended right
                        into the background after a long list of exercises,
                        easy to scroll past without ever registering it was
                        there -- a visible top border plus real button
                        styling (matching the brand-tinted pill buttons used
                        everywhere else in this flow, not another quiet text
                        link) gives it the same weight as "Try another like
                        this" right above it. */}
                    {subtopics.length > 0 && (
                      <div className="mt-4 flex flex-wrap gap-1.5 border-t border-border pt-3">
                        <button
                          type="button"
                          onClick={handleBackToSubtopics}
                          className="rounded-full bg-brand/10 px-2.5 py-1 text-xs font-medium text-brand transition hover:bg-brand/20"
                        >
                          ← Different sub-topic
                        </button>
                        {/* Only the concept path (WBBSE/ICSE's own
                            content-chunk fallback, see chunkConcepts.ts)
                            needs this -- a real mined sub-topic already
                            gets an equivalent "Generate another" from
                            PatternPicker above (see its own subTopic prop),
                            and the flat "all exercises" pick has nothing
                            here to scope a fresh call to. Reported
                            directly: this concept path had no way at all
                            to get more questions on the same sub-topic
                            once the initial batch of three ran out --
                            reuses generate-for-concept (always fresh, never
                            banked, see handleLoadConceptExercises' own
                            comment) with append:true so the earlier
                            questions -- and any answers already typed into
                            them -- stay put.
                            Deliberately NOT worded "Generate another" --
                            reported directly: with PatternPicker's own
                            "Generate another" sometimes visible further up
                            in the SAME panel (a chapter can have both real
                            mined patterns AND its own content-chunk
                            concepts), two near-identical labels for two
                            different-scoped actions read as one confusing
                            duplicate. "More practice on this concept"
                            names what it's actually scoped to instead. */}
                        {selectedSubtopic?.kind === "concept" && (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                selectedExerciseTopic &&
                                selectedSubtopic.kind === "concept" &&
                                void handleLoadConceptExercises(
                                  selectedExerciseTopic,
                                  selectedSubtopic.id,
                                  true,
                                  conceptType,
                                )
                              }
                              disabled={loadingMoreExercises}
                              className="rounded-full bg-brand/10 px-2.5 py-1 text-xs font-medium text-brand transition hover:bg-brand/20 disabled:opacity-60"
                            >
                              {loadingMoreExercises
                                ? "Generating…"
                                : "More practice on this concept"}
                            </button>
                            {/* Reported directly: no way to ask for a
                                specific question type at all. Mirrors
                                PatternPicker's own type picker (see its own
                                comment) -- clicking a pill both sets it as
                                the sticky preference for the plain button
                                above AND immediately generates one more
                                batch at that type, same one-click feel. */}
                            <span className="self-center text-xs text-foreground/40">
                              Type:
                            </span>
                            {EXERCISE_TYPES.map((t) => (
                              <button
                                key={t}
                                type="button"
                                onClick={() => {
                                  setConceptType(t);
                                  if (
                                    selectedExerciseTopic &&
                                    selectedSubtopic.kind === "concept"
                                  ) {
                                    void handleLoadConceptExercises(
                                      selectedExerciseTopic,
                                      selectedSubtopic.id,
                                      true,
                                      t,
                                    );
                                  }
                                }}
                                disabled={loadingMoreExercises}
                                title={`Generate more, ${EXERCISE_TYPE_LABELS[t]}`}
                                className={`rounded-full px-2 py-0.5 text-xs font-medium transition disabled:opacity-40 ${
                                  conceptType === t
                                    ? "bg-brand text-white"
                                    : "bg-foreground/10 text-foreground/60 hover:bg-foreground/20"
                                }`}
                              >
                                {EXERCISE_TYPE_LABELS[t]}
                              </button>
                            ))}
                            <button
                              type="button"
                              onClick={() => setConceptType(undefined)}
                              disabled={
                                loadingMoreExercises ||
                                conceptType === undefined
                              }
                              title="Any type"
                              className="rounded-full bg-foreground/10 px-2 py-0.5 text-xs font-medium text-foreground/60 transition hover:bg-foreground/20 disabled:opacity-40"
                            >
                              Any
                            </button>
                          </>
                        )}
                      </div>
                    )}
                    {/* Repeats the top-of-panel error too (see the
                        exercisesError block near the top of this branch)
                        -- an error from THIS action needs to be visible
                        right next to the button that triggered it, not
                        only above a possibly long, already-scrolled-past
                        exercise list. */}
                    {exercisesError && (
                      <p className="mt-2 text-xs text-red-600">
                        {exercisesError}
                      </p>
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
