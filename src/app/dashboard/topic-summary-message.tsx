"use client";

import { useEffect, useRef, useState } from "react";
import { MathText } from "@/components/math-text";
import { TableText } from "@/components/markdown-table";
import { LoadingIndicator } from "@/components/loading-indicator";
import { FeedbackButtons } from "@/components/feedback-buttons";
import type { SyllabusTopic } from "@/lib/supabase/types";

// The primary "Relevant Exercises" path -- always has a real, stable
// answered_questions row id (see /v1/topic-exercises's own response
// shape), so these can be graded (see GradeState below). The tag-filter
// path (SearchExercise, further down) reuses a DIFFERENT endpoint
// (/api/answer-bank/search) that has no id in its response shape --
// deliberately left showing its answer immediately, unchanged, rather
// than extending that endpoint too; see the render branch below.
type ExerciseItem = { id: string; question: string; answer: string };
type SearchExercise = { question: string; answer: string };
type ExerciseVerdict = "correct" | "partially_correct" | "incorrect";
type DifficultyLevel = "Easy" | "Medium" | "Hard";

// A curated, real exam pattern mined for this exact topic -- powers the
// "Practice a specific pattern" picker below the auto-loaded exercises
// (Tier C/D). runId is carried through (never shown) purely so a click
// can identify which pattern was picked back to the server -- archetypeId
// alone isn't unique across runs. Empty (the common case for most
// topics right now) just means the picker doesn't render at all.
// difficultyDistribution (Tier D) is the pattern's own real historical
// spread -- shown as a hint next to the Easy/Medium/Hard buttons so a
// student can see up front how (un)common the level they're about to
// pick actually is for this pattern, rather than it silently being
// calibrated (or not) only after they've already asked.
type Pattern = {
  runId: string;
  archetypeId: string;
  name: string;
  difficultyDistribution: Record<DifficultyLevel, number> | null;
};

// Per-exercise submission/grading state, keyed by exercise id -- a
// student attempts each exercise independently, so this can't be one
// shared piece of state for the whole list. "idle" covers both "hasn't
// typed anything yet" and "typed something, hasn't submitted" -- draft
// alone distinguishes those, nothing in the UI needs a third status for it.
type GradeState = {
  draft: string;
  status: "idle" | "submitting" | "graded";
  verdict?: ExerciseVerdict;
  feedback?: string;
  revealedAnswer?: string;
  error?: string;
};

// Sentinel `generating` key for "Generate another" (no specific pattern),
// distinct from any real archetypeId.
const GENERATING_RANDOM = "__random__";

const DIFFICULTY_LEVELS: DifficultyLevel[] = ["Easy", "Medium", "Hard"];

// "Usually Hard (7 of 10 mined)" -- raw counts, not a percentage, so this
// stays honest about how little data some patterns have (a percentage of
// 1 question would read as false precision) and never claims anything
// about a pattern with nothing classified at all.
function describeDifficultyHint(dist: Record<DifficultyLevel, number> | null): string | null {
  if (!dist) return null;
  const total = dist.Easy + dist.Medium + dist.Hard;
  if (total === 0) return null;
  const [top, topCount] = DIFFICULTY_LEVELS.map((level) => [level, dist[level]] as const).sort((a, b) => b[1] - a[1])[0];
  return `Usually ${top} (${topCount} of ${total} mined)`;
}

const VERDICT_STYLES: Record<ExerciseVerdict, { box: string; label: string }> = {
  correct: { box: "bg-green-50 text-green-800", label: "Correct!" },
  partially_correct: { box: "bg-yellow-50 text-yellow-800", label: "Partially correct." },
  incorrect: { box: "bg-red-50 text-red-800", label: "Not quite." },
};

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

  const [exercises, setExercises] = useState<ExerciseItem[] | null>(null);
  const [exercisesError, setExercisesError] = useState<string | null>(null);
  const [loadingExercises, setLoadingExercises] = useState(false);
  const [gradeStates, setGradeStates] = useState<Record<string, GradeState>>({});

  // Tags actually present among this topic's own banked entries (an admin
  // has to have tagged a topic-scoped entry for any of this to show up --
  // see addTag in admin/answer-bank/actions.ts) -- offered as a way to
  // narrow the topic's exercises down further, e.g. "just the ones from
  // Ganit Prakash," without leaving the chat timeline for the full Practice
  // panel search.
  const [topicTags, setTopicTags] = useState<string[]>([]);
  const [activeTagFilter, setActiveTagFilter] = useState<string | null>(null);
  const [filteredExercises, setFilteredExercises] = useState<SearchExercise[] | null>(null);
  const [loadingFilter, setLoadingFilter] = useState(false);

  // On-demand pattern picker (Tier C/D). `generating` holds the
  // archetypeId of whichever button was clicked (or GENERATING_RANDOM for
  // "Generate another"), so only THAT button shows a busy state -- not a
  // single shared boolean that would grey out every button in the row at
  // once. `pendingSelection` is which pattern (or, with pattern: null,
  // "Generate another") the student has clicked but not yet chosen a
  // difficulty for -- clicking a pattern name doesn't generate
  // immediately, it opens the Easy/Medium/Hard/Any row below it first.
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [pendingSelection, setPendingSelection] = useState<{ pattern: Pattern | null } | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);

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
    if (!loadingSummary) onSummaryLoadedRef.current?.(summaryError ? null : summary);
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
    setExercises(null);
    setExercisesError(null);
    setGradeStates({});
    setTopicTags([]);
    setActiveTagFilter(null);
    setFilteredExercises(null);
    setPatterns([]);
    setPendingSelection(null);
    setGenerateError(null);
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

      // Both best-effort -- if either fails, the tag chips or the pattern
      // picker just don't show; the exercises themselves already loaded
      // fine, so neither failure is surfaced as an error.
      const [tagsRes, patternsRes] = await Promise.all([
        fetch(`/api/answer-bank/tags?subjectId=${encodeURIComponent(topic.subject_id)}&topicId=${encodeURIComponent(topic.id)}`),
        fetch(`/api/topics/${topic.id}/exercises/patterns`),
      ]);
      const tagsBody = await tagsRes.json().catch(() => null);
      if (tagsRes.ok && Array.isArray(tagsBody?.tags)) {
        setTopicTags(tagsBody.tags);
      }
      const patternsBody = await patternsRes.json().catch(() => null);
      if (patternsRes.ok && Array.isArray(patternsBody?.patterns)) {
        setPatterns(patternsBody.patterns);
      }
    } catch {
      setExercisesError("Could not load exercises.");
    } finally {
      setLoadingExercises(false);
    }
  }

  async function handleGeneratePattern(pattern?: Pattern, requestedDifficulty?: DifficultyLevel) {
    if (generating !== null) return;
    setGenerating(pattern?.archetypeId ?? GENERATING_RANDOM);
    setGenerateError(null);
    setPendingSelection(null);
    try {
      const res = await fetch(`/api/topics/${topic.id}/exercises/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(pattern ? { archetypeId: pattern.archetypeId, archetypeRunId: pattern.runId } : {}),
          ...(requestedDifficulty ? { requestedDifficulty } : {}),
          preferEnglish,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setGenerateError(body?.error ?? "Could not generate a question right now.");
        return;
      }
      if (body?.exercise) {
        // Appended to the same list the auto-loaded exercises render
        // through -- one unified, hide-until-submitted list, not a
        // separate section with its own grading UI to keep in sync.
        setExercises((prev) => [...(prev ?? []), body.exercise as ExerciseItem]);
      } else {
        setGenerateError("Could not generate a question right now.");
      }
    } catch {
      setGenerateError("Could not generate a question right now.");
    } finally {
      setGenerating(null);
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

  function getGradeState(exerciseId: string): GradeState {
    return gradeStates[exerciseId] ?? { draft: "", status: "idle" };
  }

  function setGradeState(exerciseId: string, next: GradeState) {
    setGradeStates((prev) => ({ ...prev, [exerciseId]: next }));
  }

  async function handleSubmitAnswer(exerciseId: string) {
    const state = getGradeState(exerciseId);
    if (!state.draft.trim() || state.status === "submitting") return;

    setGradeState(exerciseId, { ...state, status: "submitting", error: undefined });
    try {
      const res = await fetch(`/api/exercises/${exerciseId}/grade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: state.draft }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || typeof body?.verdict !== "string") {
        setGradeState(exerciseId, { ...state, status: "idle", error: body?.error ?? "Could not grade this attempt." });
        return;
      }
      setGradeState(exerciseId, {
        ...state,
        status: "graded",
        verdict: body.verdict as ExerciseVerdict,
        feedback: body.feedback,
        revealedAnswer: body.answer,
      });
    } catch {
      setGradeState(exerciseId, { ...state, status: "idle", error: "Could not grade this attempt." });
    }
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
                ) : activeTagFilter ? (
                  // Tag-filtered results come from a different endpoint
                  // (/api/answer-bank/search) with no stable id in its
                  // response shape -- shown immediately, same as before
                  // the grading flow existed, rather than extending that
                  // endpoint too. See SearchExercise's own comment.
                  filteredExercises === null || filteredExercises.length === 0 ? (
                    <p className="text-foreground/50">No exercises tagged &quot;{activeTagFilter}&quot; for this topic.</p>
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
                              subjectId={topic.subject_id}
                              question={`${topic.chapter} / ${topic.topic}`}
                              contentSnapshot={`Q: ${ex.question}\n\nA: ${ex.answer}`}
                            />
                          </li>
                        ))}
                      </ol>
                    </>
                  )
                ) : (
                  <>
                    {exercises.length === 0 ? (
                      <p className="text-foreground/50">No exercises available for this topic yet.</p>
                    ) : (
                      <>
                        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground/40">
                          Relevant exercises
                        </p>
                        <p className="mb-3 text-xs text-foreground/40">
                          Try each one yourself first -- the worked solution shows once you check your answer.
                        </p>
                        <ol className="space-y-4">
                          {exercises.map((ex, i) => {
                            const state = getGradeState(ex.id);
                            return (
                              <li key={ex.id}>
                                <p className="whitespace-pre-wrap font-medium">
                                  {i + 1}. <MathText text={ex.question} />
                                </p>

                                {state.status === "graded" ? (
                                  <div className="mt-1.5 space-y-2">
                                    <p className={`rounded-lg p-3 ${VERDICT_STYLES[state.verdict as ExerciseVerdict].box}`}>
                                      <span className="font-semibold">
                                        {VERDICT_STYLES[state.verdict as ExerciseVerdict].label}
                                      </span>{" "}
                                      {state.feedback}
                                    </p>
                                    <div className="rounded-lg bg-background p-3 text-foreground/80">
                                      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground/40">
                                        Solution
                                      </p>
                                      <p className="whitespace-pre-wrap">
                                        <MathText text={state.revealedAnswer ?? ""} />
                                      </p>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="mt-1.5 space-y-1.5">
                                    <textarea
                                      value={state.draft}
                                      onChange={(e) => setGradeState(ex.id, { ...state, draft: e.target.value })}
                                      placeholder="Type your answer here…"
                                      rows={2}
                                      disabled={state.status === "submitting"}
                                      className="w-full rounded-lg border border-border bg-background p-2 text-sm text-foreground disabled:opacity-60"
                                    />
                                    {state.error && <p className="text-xs text-red-600">{state.error}</p>}
                                    <button
                                      type="button"
                                      onClick={() => handleSubmitAnswer(ex.id)}
                                      disabled={state.status === "submitting" || !state.draft.trim()}
                                      className="rounded-lg bg-brand px-3 py-1 text-xs font-medium text-white hover:bg-brand-dark disabled:opacity-60"
                                    >
                                      {state.status === "submitting" ? "Checking…" : "Check my answer"}
                                    </button>
                                  </div>
                                )}

                                {/* No target_id, same reasoning as the tag-filter
                                    path above -- FeedbackButtons is about the
                                    exercise's own quality, independent of
                                    whether (or how) the student has attempted
                                    it yet, so this stays visible either way. */}
                                <FeedbackButtons
                                  kind="exercise"
                                  subjectId={topic.subject_id}
                                  question={`${topic.chapter} / ${topic.topic}`}
                                  contentSnapshot={`Q: ${ex.question}\n\nA: ${ex.answer}`}
                                />
                              </li>
                            );
                          })}
                        </ol>
                      </>
                    )}

                    {patterns.length > 0 && (
                      <div className="mt-4 border-t border-border pt-3">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground/40">
                          Practice a specific pattern
                        </p>
                        {generateError && <p className="mb-2 text-xs text-red-600">{generateError}</p>}
                        <div className="flex flex-wrap gap-1.5">
                          {patterns.map((p) => {
                            const isSelected = pendingSelection?.pattern?.archetypeId === p.archetypeId;
                            return (
                              <button
                                key={`${p.runId}:${p.archetypeId}`}
                                type="button"
                                onClick={() => setPendingSelection(isSelected ? null : { pattern: p })}
                                disabled={generating !== null}
                                className={`rounded-full px-2.5 py-1 text-xs font-medium transition disabled:opacity-60 ${
                                  isSelected ? "bg-brand text-white" : "bg-brand/10 text-brand hover:bg-brand/20"
                                }`}
                              >
                                {generating === p.archetypeId ? "Generating…" : p.name}
                              </button>
                            );
                          })}
                          <button
                            type="button"
                            onClick={() =>
                              setPendingSelection(pendingSelection && !pendingSelection.pattern ? null : { pattern: null })
                            }
                            disabled={generating !== null}
                            className={`rounded-full px-2.5 py-1 text-xs font-medium transition disabled:opacity-60 ${
                              pendingSelection && !pendingSelection.pattern
                                ? "bg-foreground/70 text-white"
                                : "bg-foreground/10 text-foreground/60 hover:bg-foreground/20"
                            }`}
                          >
                            {generating === GENERATING_RANDOM ? "Generating…" : "Generate another"}
                          </button>
                        </div>

                        {/* Picking a pattern (or "Generate another") doesn't
                            fire the request immediately -- it opens this
                            difficulty row first, so a student can see the
                            pattern's own real historical spread before
                            deciding, rather than only finding out afterward
                            that (say) "Easy" almost never appears in real
                            exams for it. */}
                        {pendingSelection && (
                          <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-lg bg-background p-2">
                            <span className="text-xs text-foreground/50">
                              {pendingSelection.pattern
                                ? describeDifficultyHint(pendingSelection.pattern.difficultyDistribution) ??
                                  "No difficulty data yet —"
                                : "Difficulty:"}
                            </span>
                            {DIFFICULTY_LEVELS.map((level) => (
                              <button
                                key={level}
                                type="button"
                                onClick={() => handleGeneratePattern(pendingSelection.pattern ?? undefined, level)}
                                disabled={generating !== null}
                                className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand hover:bg-brand/20 disabled:opacity-60"
                              >
                                {level}
                              </button>
                            ))}
                            <button
                              type="button"
                              onClick={() => handleGeneratePattern(pendingSelection.pattern ?? undefined)}
                              disabled={generating !== null}
                              className="rounded-full bg-foreground/10 px-2 py-0.5 text-xs font-medium text-foreground/60 hover:bg-foreground/20 disabled:opacity-60"
                            >
                              Any
                            </button>
                            <button
                              type="button"
                              onClick={() => setPendingSelection(null)}
                              className="ml-auto text-xs text-foreground/40 hover:underline"
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                      </div>
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
