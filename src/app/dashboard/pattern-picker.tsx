"use client";

import { useEffect, useState } from "react";

// Kept intentionally minimal -- callers only ever need to append this to
// their own exercise list, never anything else about it.
export type PatternPickerExercise = { id: string; question: string; answer: string };

type DifficultyLevel = "Easy" | "Medium" | "Hard";

// A curated, real exam pattern mined for a topic -- see the endpoint's own
// comment (/api/topics/[id]/exercises/patterns) for the full shape.
// difficultyDistribution is the pattern's own real historical spread,
// shown as a hint next to the Easy/Medium/Hard buttons so a student can
// see up front how (un)common the level they're about to pick actually is
// for this pattern, rather than it silently being calibrated (or not)
// only after they've already asked.
type Pattern = {
  runId: string;
  archetypeId: string;
  name: string;
  difficultyDistribution: Record<DifficultyLevel, number> | null;
  // Sorted ascending, e.g. [2025, 2026] -- suffixed onto the button label
  // (see describeYearsSuffix) so a student can see which real exam years
  // actually tested this pattern before picking it.
  yearsObserved: number[];
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

// " (2025, 2026)" -- empty string (no suffix at all) when nothing's
// classified, rather than an empty "()" hanging off the name.
function describeYearsSuffix(years: number[]): string {
  return years.length > 0 ? ` (${years.join(", ")})` : "";
}

// Curated "practice a specific mined pattern" picker (Tier C/D) --
// self-contained: fetches its own pattern list for `topicId` on mount
// (and again on any topicId/preferEnglish change) and manages its own
// generate/difficulty-selection state, so it can be dropped under any
// surface that has resolved a real syllabus_topics id -- originally built
// for (and still used by) TopicSummaryMessage's "Relevant Exercises"
// section, where topicId is known statically (the topic that was
// clicked); also dropped directly under an ordinary chat reply
// (MessageBubble in chat-panel.tsx), where topicId is instead resolved
// server-side from the question itself (see /api/chat/route.ts's
// matchedTopicId) -- same component either way, so a fix here never needs
// making twice.
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
  onExerciseGenerated,
}: {
  topicId: string;
  preferEnglish: boolean;
  onExerciseGenerated: (exercise: PatternPickerExercise) => void;
}) {
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Which pattern (or, with pattern: null, "Generate another") the
  // student has clicked but not yet chosen a difficulty for -- clicking a
  // pattern name doesn't generate immediately, it opens the
  // Easy/Medium/Hard/Any row below it first.
  const [pendingSelection, setPendingSelection] = useState<{ pattern: Pattern | null } | null>(null);
  // Holds the archetypeId of whichever button was clicked (or
  // GENERATING_RANDOM for "Generate another"), so only THAT button shows
  // a busy state -- not a single shared boolean that would grey out every
  // button in the row at once.
  const [generating, setGenerating] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // No manual reset of loaded/patterns/pendingSelection/generateError here
  // on a topicId/preferEnglish change -- callers key this component on
  // both (see TopicPractice), so a change remounts it fresh with already-
  // correct initial state instead of this effect reaching back to reset
  // state React's own docs call out as the anti-pattern this replaces
  // (https://react.dev/learn/you-might-not-need-an-effect#resetting-all-
  // state-when-a-prop-changes).
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/topics/${topicId}/exercises/patterns`);
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
  }, [topicId, preferEnglish]);

  async function handleGeneratePattern(pattern?: Pattern, requestedDifficulty?: DifficultyLevel) {
    if (generating !== null) return;
    setGenerating(pattern?.archetypeId ?? GENERATING_RANDOM);
    setGenerateError(null);
    setPendingSelection(null);
    try {
      const res = await fetch(`/api/topics/${topicId}/exercises/generate`, {
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
        onExerciseGenerated(body.exercise as PatternPickerExercise);
      } else {
        setGenerateError("Could not generate a question right now.");
      }
    } catch {
      setGenerateError("Could not generate a question right now.");
    } finally {
      setGenerating(null);
    }
  }

  if (!loaded || patterns.length === 0) return null;

  return (
    <div className="mt-4 border-t border-border pt-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground/40">Practice a specific pattern</p>
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
              {generating === p.archetypeId ? "Generating…" : `${p.name}${describeYearsSuffix(p.yearsObserved)}`}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setPendingSelection(pendingSelection && !pendingSelection.pattern ? null : { pattern: null })}
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

      {/* Picking a pattern (or "Generate another") doesn't fire the
          request immediately -- it opens this difficulty row first, so a
          student can see the pattern's own real historical spread before
          deciding, rather than only finding out afterward that (say)
          "Easy" almost never appears in real exams for it. */}
      {pendingSelection && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-lg bg-background p-2">
          <span className="text-xs text-foreground/50">
            {pendingSelection.pattern
              ? (describeDifficultyHint(pendingSelection.pattern.difficultyDistribution) ?? "No difficulty data yet —")
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
          <button type="button" onClick={() => setPendingSelection(null)} className="ml-auto text-xs text-foreground/40 hover:underline">
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
