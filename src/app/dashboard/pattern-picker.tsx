"use client";

import { useEffect, useState } from "react";

// Kept intentionally minimal -- callers only ever need to append this to
// their own exercise list, never anything else about it.
export type PatternPickerExercise = {
  id: string;
  question: string;
  answer: string;
  type?: ExerciseType | null;
};

type DifficultyLevel = "Easy" | "Medium" | "Hard";
// A small, curated, app-facing set -- see the orchestrator's own
// ExerciseType comment for why this is deliberately narrower than the
// archetype-miner's internal QuestionFormat taxonomy. Reported directly:
// there was no way to ask for a specific one at all, only "whatever the
// model produced."
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

// A curated, real exam pattern mined for a topic -- see the endpoint's own
// comment (/api/topics/[id]/exercises/patterns) for the full shape.
// difficultyDistribution is the pattern's own real historical spread, used
// both to pick a sensible default difficulty on first click (see
// topDifficulty) and, once shown, as context next to the repeat/difficulty
// controls -- a student can see how (un)common the level they're on
// actually is for this pattern.
type Pattern = {
  runId: string;
  archetypeId: string;
  name: string;
  // Plain-language explanation of the underlying concept -- shown in the
  // panel below once this pattern has generated at least one question, so
  // a student gets a short refresher on the concept itself while
  // practicing it, not just the pattern's own (often terse) name. null for
  // an archetype that predates this field or hasn't been backfilled yet.
  studentExplanation: string | null;
  difficultyDistribution: Record<DifficultyLevel, number> | null;
  // Sorted ascending, e.g. [2025, 2026] -- suffixed onto the button label
  // (see describeYearsSuffix) so a student can see which real exam years
  // actually tested this pattern before picking it.
  yearsObserved: number[];
  // How many of this pattern's own supporting questions came from each
  // year, e.g. { "2025": 1, "2026": 2 } -- also suffixed onto the button
  // label so "asked twice in 2026" reads differently from "asked once."
  questionCountByYear: Record<string, number>;
};

// Sentinel `generating` key for "Generate another" (no specific pattern),
// distinct from any real archetypeId.
const GENERATING_RANDOM = "__random__";
// How many new questions one click here produces -- kept equal to the
// concept path's own CONCEPT_EXERCISE_COUNT in server.ts (see its own
// comment); this route itself only ever generates one exercise per call
// (see handleGenerate's own comment on why this fires that many parallel
// requests rather than asking the route for more at once).
const ON_DEMAND_EXERCISE_COUNT = 2;
const DIFFICULTY_LEVELS: DifficultyLevel[] = ["Easy", "Medium", "Hard"];

// The single most-observed level for this pattern's real mined questions,
// used to pick a sensible default the FIRST time a student clicks it --
// no reason to make them choose a difficulty before they've even seen one
// question of this pattern. null (no data, or nothing classified) falls
// back to requesting no particular difficulty at all, same as "Any".
function topDifficulty(
  dist: Record<DifficultyLevel, number> | null,
): DifficultyLevel | undefined {
  if (!dist) return undefined;
  const total = dist.Easy + dist.Medium + dist.Hard;
  if (total === 0) return undefined;
  return DIFFICULTY_LEVELS.map((level) => [level, dist[level]] as const).sort(
    (a, b) => b[1] - a[1],
  )[0][0];
}

// "Usually Hard (7 of 10 mined)" -- raw counts, not a percentage, so this
// stays honest about how little data some patterns have (a percentage of
// 1 question would read as false precision) and never claims anything
// about a pattern with nothing classified at all.
function describeDifficultyHint(
  dist: Record<DifficultyLevel, number> | null,
): string | null {
  if (!dist) return null;
  const total = dist.Easy + dist.Medium + dist.Hard;
  if (total === 0) return null;
  const [top, topCount] = DIFFICULTY_LEVELS.map(
    (level) => [level, dist[level]] as const,
  ).sort((a, b) => b[1] - a[1])[0];
  return `Usually ${top} (${topCount} of ${total} mined)`;
}

// " (2025, 2026 ×2)" -- how many of this pattern's own questions came
// from each year, not just which years it appeared in; a year with no
// count data (a lookup failure, or a paper with no recorded year) falls
// back to the bare year rather than hiding it. Empty string (no suffix at
// all) when nothing's classified, rather than an empty "()" hanging off
// the name.
function describeYearsSuffix(
  years: number[],
  countByYear: Record<string, number>,
): string {
  if (years.length === 0) return "";
  const parts = years.map((year) => {
    const count = countByYear[String(year)];
    return count ? `${year} ×${count}` : `${year}`;
  });
  return ` (${parts.join(", ")})`;
}

// Which pattern (or, with pattern: null, the random "Generate another")
// most recently generated a question, and at which difficulty/type --
// drives the repeat panel below the pill row. Distinct from `generating`
// (which tracks an in-flight request): this stays set across requests so
// "Try another like this" always knows what to repeat. Unlike difficulty
// (reset to each pattern's OWN historically-common level on every new
// pattern click, see topDifficulty), a chosen type carries over across
// pattern switches -- there's no per-pattern "natural" type the way
// there's a per-pattern natural difficulty, so a student who picked MCQ
// once most likely wants MCQ from the NEXT pattern too, not silently back
// to "Any."
type ActiveSelection = {
  pattern: Pattern | null;
  difficulty: DifficultyLevel | undefined;
  type: ExerciseType | undefined;
};

// Curated "practice a specific mined pattern" picker (Tier C/D) --
// self-contained: fetches its own pattern list for `topicId` on mount
// (and again on any topicId/preferEnglish change) and manages its own
// generate/selection state, so it can be dropped under any surface that
// has resolved a real syllabus_topics id -- originally built for (and
// still used by) TopicSummaryMessage's "Relevant Exercises" section,
// where topicId is known statically (the topic that was clicked); also
// dropped directly under an ordinary chat reply (MessageBubble in
// chat-panel.tsx), where topicId is instead resolved server-side from the
// question itself (see /api/chat/route.ts's matchedTopicId) -- same
// component either way, so a fix here never needs making twice.
//
// One click, one question, immediately -- no difficulty gate in front of
// the first question of a pattern. Confirmed directly: the earlier
// two-step "click a pattern -> pick Easy/Medium/Hard/Any before anything
// happens" shape forced every student through a calibration decision even
// when they didn't care, and then produced exactly one question with no
// easy way to keep going -- "practice" in name, a dead end in practice.
// Clicking a pattern now generates right away at that pattern's own most
// historically common difficulty (topDifficulty); the difficulty row
// becomes an OPTIONAL refinement shown only after the first question,
// next to a one-click "Try another like this" repeat.
//
// Renders nothing at all once loaded with an empty pattern list (the
// common case for most topics right now, or any question the server
// couldn't confidently match to one) -- same "invisible when empty"
// posture every other archetype-facing surface in this app already uses,
// which is exactly what makes it safe to mount under every chat reply
// rather than just topic summaries: a reply that isn't really topic-
// specific just renders nothing extra.
export function PatternPicker({
  topicId,
  preferEnglish,
  subTopic,
  onExerciseGenerated,
}: {
  topicId: string;
  preferEnglish: boolean;
  // Set only when this picker is mounted underneath an already-selected
  // sub-topic pill (see topic-summary-message.tsx's own subtopic picker,
  // and TopicPractice's own comment on why this has to be threaded
  // through) -- narrows both the listed patterns and any on-demand
  // generation down to just that sub-topic's own archetypes. Omitted
  // entirely for an ordinary chat reply's mount (chat-panel.tsx), which
  // has no sub-topic concept at all, and for TopicSummaryMessage's own
  // "All exercises for this chapter" pick.
  subTopic?: string;
  onExerciseGenerated: (exercise: PatternPickerExercise) => void;
}) {
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [active, setActive] = useState<ActiveSelection | null>(null);
  // Holds the archetypeId of whichever button was clicked (or
  // GENERATING_RANDOM for "Generate another"), so only THAT button shows
  // a busy state -- not a single shared boolean that would grey out every
  // button in the row at once.
  const [generating, setGenerating] = useState<string | null>(null);
  // Which ROW triggered the in-flight request -- the top pill row, or the
  // refinement panel's own "Try another like this"/"Generate another"
  // button. Reported directly: clicking "Try another like this" showed
  // "Generating…" on BOTH that button AND the matching pattern pill above
  // it at once, reading like two separate things were happening, when it
  // was really the same one request `generating` alone can't distinguish
  // (a pill's own label only checks `generating === p.archetypeId`, which
  // is equally true whether the PILL or the PANEL button was what was
  // actually clicked). Only the row that was actually clicked shows the
  // "Generating…" text now; the other's `disabled` state alone still
  // reflects the in-flight request, without duplicating the label.
  const [generatingTrigger, setGeneratingTrigger] = useState<
    "pill" | "refine" | null
  >(null);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // No manual reset of loaded/patterns/active/generateError here on a
  // topicId/preferEnglish change -- callers key this component on both
  // (see TopicPractice), so a change remounts it fresh with already-
  // correct initial state instead of this effect reaching back to reset
  // state React's own docs call out as the anti-pattern this replaces
  // (https://react.dev/learn/you-might-not-need-an-effect#resetting-all-
  // state-when-a-prop-changes). Fetching itself is exactly what useEffect
  // IS for (unlike a plain state adjustment) -- this is the one place in
  // this component that still needs one.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const query = subTopic
          ? `?subTopic=${encodeURIComponent(subTopic)}`
          : "";
        const res = await fetch(
          `/api/topics/${topicId}/exercises/patterns${query}`,
        );
        const body = await res.json().catch(() => null);
        if (!cancelled && res.ok && Array.isArray(body?.patterns)) {
          setPatterns(body.patterns);
        }
      } catch {
        // Best-effort -- see the component's own doc comment: a failure
        // here just means nothing renders, never a broken parent view.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [topicId, preferEnglish, subTopic]);

  async function handleGenerate(
    selection: ActiveSelection,
    trigger: "pill" | "refine",
  ) {
    if (generating !== null) return;
    const key = selection.pattern?.archetypeId ?? GENERATING_RANDOM;
    setGenerating(key);
    setGeneratingTrigger(trigger);
    setGenerateError(null);
    setActive(selection);
    try {
      const requestBody = JSON.stringify({
        ...(selection.pattern
          ? {
              archetypeId: selection.pattern.archetypeId,
              archetypeRunId: selection.pattern.runId,
            }
          : {}),
        ...(selection.difficulty
          ? { requestedDifficulty: selection.difficulty }
          : {}),
        ...(selection.type ? { requestedType: selection.type } : {}),
        ...(subTopic ? { subTopic } : {}),
        preferEnglish,
      });
      // This route only ever generates ONE exercise per call -- fired
      // ON_DEMAND_EXERCISE_COUNT times in parallel instead of asking the
      // route itself for more, so its response shape (and every other
      // caller of it) stays untouched. Reported directly: a click here
      // produced a visibly different number of new questions than a click
      // on the concept path's own "Generate more exercises" (see
      // CONCEPT_EXERCISE_COUNT in server.ts, kept equal to this). Fired
      // with an unspecific archetypeId (the "Generate another" pick), each
      // call independently random-picks its own archetype -- acceptable
      // variety, not a bug; with a specific pattern, all calls target the
      // exact same one, since archetypeId/archetypeRunId are pinned in the
      // shared request body.
      const results = await Promise.allSettled(
        Array.from({ length: ON_DEMAND_EXERCISE_COUNT }, () =>
          fetch(`/api/topics/${topicId}/exercises/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: requestBody,
          }).then(async (res) => ({
            ok: res.ok,
            body: await res.json().catch(() => null),
          })),
        ),
      );

      let addedAny = false;
      let lastError: string | null = null;
      for (const result of results) {
        if (result.status !== "fulfilled") {
          lastError = "Could not generate a question right now.";
          continue;
        }
        if (result.value.ok && result.value.body?.exercise) {
          onExerciseGenerated(
            result.value.body.exercise as PatternPickerExercise,
          );
          addedAny = true;
        } else {
          lastError =
            result.value.body?.error ??
            "Could not generate a question right now.";
        }
      }
      // A partial success (e.g. 1 of 2) is still real progress -- only
      // surfaced as an error when NOTHING came back at all.
      if (!addedAny) {
        setGenerateError(
          lastError ?? "Could not generate a question right now.",
        );
      }
    } catch {
      setGenerateError("Could not generate a question right now.");
    } finally {
      setGenerating(null);
      setGeneratingTrigger(null);
    }
  }

  if (!loaded || patterns.length === 0) return null;

  return (
    <div className="mt-4 border-t border-border pt-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground/40">
        Practice a specific pattern
      </p>
      {generateError && (
        <p className="mb-2 text-xs text-red-600">{generateError}</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {patterns.map((p) => {
          const isActive = active?.pattern?.archetypeId === p.archetypeId;
          return (
            <button
              key={`${p.runId}:${p.archetypeId}`}
              type="button"
              onClick={() =>
                void handleGenerate(
                  {
                    pattern: p,
                    difficulty: topDifficulty(p.difficultyDistribution),
                    type: active?.type,
                  },
                  "pill",
                )
              }
              disabled={generating !== null}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition disabled:opacity-60 ${
                isActive
                  ? "bg-brand text-white"
                  : "bg-brand/10 text-brand hover:bg-brand/20"
              }`}
            >
              {generating === p.archetypeId && generatingTrigger === "pill"
                ? "Generating…"
                : `${p.name}${describeYearsSuffix(p.yearsObserved, p.questionCountByYear)}`}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() =>
            void handleGenerate(
              {
                pattern: null,
                difficulty: undefined,
                type: active?.type,
              },
              "pill",
            )
          }
          disabled={generating !== null}
          // Reported directly: this pill "doesn't appear" -- it renders
          // unconditionally, same as every pattern pill next to it, but
          // its own unselected style (a very muted gray on gray) blended
          // into the row next to the much more visible brand-purple
          // pattern pills, easy to scan right past. A visible border in
          // BOTH states -- not just a contrast bump -- keeps it clearly
          // present, and deliberately still neutral-toned (not brand
          // purple) so it still reads as "a different kind of action,"
          // not one more mined pattern.
          className={`rounded-full border px-2.5 py-1 text-xs font-medium transition disabled:opacity-60 ${
            active && !active.pattern
              ? "border-foreground/70 bg-foreground/70 text-white"
              : "border-foreground/30 bg-foreground/5 text-foreground/70 hover:bg-foreground/10"
          }`}
        >
          {generating === GENERATING_RANDOM && generatingTrigger === "pill"
            ? "Generating…"
            : "Generate another"}
        </button>
      </div>

      {/* Only appears once at least one question has actually been
          generated this session -- a place to keep going with the same
          pattern (one click, no re-deciding anything) and, optionally,
          nudge the difficulty for the NEXT one. Never blocks the first
          question the way the old pre-generation gate did. */}
      {active && (
        <div className="mt-2 rounded-lg bg-background p-2">
          {active.pattern?.studentExplanation && (
            <p className="mb-2 text-xs text-foreground/70">
              {active.pattern.studentExplanation}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => void handleGenerate(active, "refine")}
              disabled={generating !== null}
              className="rounded-full bg-brand px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-dark disabled:opacity-60"
            >
              {generating !== null && generatingTrigger === "refine"
                ? "Generating…"
                : active.pattern
                  ? "Try another like this"
                  : "Generate another"}
            </button>
            {active.pattern && (
              <>
                <span className="text-xs text-foreground/40">
                  {describeDifficultyHint(
                    active.pattern.difficultyDistribution,
                  ) ?? "No difficulty data yet"}
                  {active.difficulty ? ` — now on ${active.difficulty}` : ""}
                </span>
                {DIFFICULTY_LEVELS.map((level) => (
                  <button
                    key={level}
                    type="button"
                    onClick={() =>
                      void handleGenerate(
                        {
                          pattern: active.pattern,
                          difficulty: level,
                          type: active.type,
                        },
                        "refine",
                      )
                    }
                    disabled={
                      generating !== null || active.difficulty === level
                    }
                    title={`Generate another, ${level}`}
                    className={`rounded-full px-2 py-0.5 text-xs font-medium transition ${
                      active.difficulty === level
                        ? "bg-brand/20 text-brand"
                        : "bg-foreground/10 text-foreground/60 hover:bg-foreground/20 disabled:opacity-40"
                    }`}
                  >
                    {level}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    void handleGenerate(
                      {
                        pattern: active.pattern,
                        difficulty: undefined,
                        type: active.type,
                      },
                      "refine",
                    )
                  }
                  disabled={
                    generating !== null || active.difficulty === undefined
                  }
                  title="Generate another, unconstrained difficulty"
                  className={`rounded-full px-2 py-0.5 text-xs font-medium transition ${
                    active.difficulty === undefined
                      ? "bg-brand/20 text-brand"
                      : "bg-foreground/10 text-foreground/60 hover:bg-foreground/20 disabled:opacity-40"
                  }`}
                >
                  Any
                </button>
              </>
            )}
            {/* Type refinement, unlike difficulty above, isn't gated on
                active.pattern -- there's no per-pattern historical type
                distribution to calibrate against (see ActiveSelection's
                own comment), so it applies just as well to the random
                "Generate another" pick as to a specific pattern.
                Reported directly: the currently-selected pill used to
                only fade (disabled:opacity-40, same as the difficulty
                pills above) -- right when the selected type happened to
                be the FIRST pill in this fixed-order list (MCQ), that put
                a dim, seemingly-broken "MCQ" button directly under a
                "Type: MCQ" label saying the identical word, reading like
                a rendering glitch rather than "you're already here."
                A distinct highlighted color (matching the difficulty
                pills' own identical fix just above) makes the current
                selection read as a clear, deliberate state instead. */}
            <span className="text-xs text-foreground/40">
              Type: {active.type ? EXERCISE_TYPE_LABELS[active.type] : "Any"}
            </span>
            {EXERCISE_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() =>
                  void handleGenerate(
                    {
                      pattern: active.pattern,
                      difficulty: active.difficulty,
                      type: t,
                    },
                    "refine",
                  )
                }
                disabled={generating !== null || active.type === t}
                title={`Generate another, ${EXERCISE_TYPE_LABELS[t]}`}
                className={`rounded-full px-2 py-0.5 text-xs font-medium transition ${
                  active.type === t
                    ? "bg-brand/20 text-brand"
                    : "bg-foreground/10 text-foreground/60 hover:bg-foreground/20 disabled:opacity-40"
                }`}
              >
                {EXERCISE_TYPE_LABELS[t]}
              </button>
            ))}
            <button
              type="button"
              onClick={() =>
                void handleGenerate(
                  {
                    pattern: active.pattern,
                    difficulty: active.difficulty,
                    type: undefined,
                  },
                  "refine",
                )
              }
              disabled={generating !== null || active.type === undefined}
              title="Generate another, any type"
              className={`rounded-full px-2 py-0.5 text-xs font-medium transition ${
                active.type === undefined
                  ? "bg-brand/20 text-brand"
                  : "bg-foreground/10 text-foreground/60 hover:bg-foreground/20 disabled:opacity-40"
              }`}
            >
              Any type
            </button>
            <button
              type="button"
              onClick={() => setActive(null)}
              className="ml-auto text-xs text-foreground/40 hover:underline"
            >
              Hide
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
