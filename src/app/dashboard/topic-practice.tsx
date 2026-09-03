"use client";

import { useState } from "react";
import { MathText } from "@/components/math-text";
import { FeedbackButtons } from "@/components/feedback-buttons";
import { PatternPicker, type PatternPickerExercise } from "./pattern-picker";

export type PracticeExerciseItem = { id: string; question: string; answer: string };
type ExerciseVerdict = "correct" | "partially_correct" | "incorrect";

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

const VERDICT_STYLES: Record<ExerciseVerdict, { box: string; label: string }> = {
  correct: { box: "bg-green-50 text-green-800", label: "Correct!" },
  partially_correct: { box: "bg-yellow-50 text-yellow-800", label: "Partially correct." },
  incorrect: { box: "bg-red-50 text-red-800", label: "Not quite." },
};

// Combines the generated-exercise list (hide-until-submitted grading UI)
// with the on-demand pattern picker underneath it -- kept as ONE unit
// since an exercise generated either way (an initial auto-loaded batch,
// or a PatternPicker click) always needs to render through the exact
// same grading flow. Self-contained: owns its own exercises/gradeStates,
// so two independent mounts (a topic-summary bubble's "Relevant
// Exercises" section, an ordinary chat reply) never share or leak state
// into each other -- each is its own fresh instance.
export function TopicPractice({
  topicId,
  subjectId,
  chapter,
  topic,
  preferEnglish,
  initialExercises,
  emptyLabel,
}: {
  topicId: string;
  subjectId: string;
  chapter: string;
  topic: string;
  preferEnglish: boolean;
  // Present only for TopicSummaryMessage's own "Relevant Exercises"
  // click-to-load batch -- omitted for an ordinary chat reply, which has
  // no such batch and starts with nothing but the pattern picker.
  initialExercises?: PracticeExerciseItem[];
  // Shown only when initialExercises was explicitly provided but came
  // back empty (TopicSummaryMessage's own "nothing banked/generated for
  // this topic" case) -- omitted for an ordinary chat reply, where
  // starting with zero exercises is the normal, unremarkable state, not
  // a failure worth a message.
  emptyLabel?: string;
}) {
  const [exercises, setExercises] = useState<PracticeExerciseItem[]>(initialExercises ?? []);
  const [gradeStates, setGradeStates] = useState<Record<string, GradeState>>({});

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

  function handleExerciseGenerated(exercise: PatternPickerExercise) {
    setExercises((prev) => [...prev, exercise]);
  }

  return (
    <div>
      {exercises.length === 0 ? (
        emptyLabel && <p className="text-foreground/50">{emptyLabel}</p>
      ) : (
        <>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground/40">Relevant exercises</p>
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
                        <span className="font-semibold">{VERDICT_STYLES[state.verdict as ExerciseVerdict].label}</span>{" "}
                        {state.feedback}
                      </p>
                      <div className="rounded-lg bg-background p-3 text-foreground/80">
                        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground/40">Solution</p>
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

                  {/* No target_id -- several exercises can share this one
                      topic and there's no stable per-instance row id used
                      for FeedbackButtons here (see its own comment on
                      targetId); content_snapshot alone is what tells this
                      exercise apart from its siblings for whoever reviews
                      it. */}
                  <FeedbackButtons
                    kind="exercise"
                    subjectId={subjectId}
                    question={`${chapter} / ${topic}`}
                    contentSnapshot={`Q: ${ex.question}\n\nA: ${ex.answer}`}
                  />
                </li>
              );
            })}
          </ol>
        </>
      )}

      {/* Keyed on topicId+preferEnglish so either changing remounts
          PatternPicker fresh (see its own comment on why it resets this
          way, not via an in-effect reset). Never actually changes within
          TopicSummaryMessage's own usage (topicId is fixed once loaded,
          and a preferEnglish flip already remounts this whole
          TopicPractice instance one level up) -- matters for
          chat-panel.tsx's usage, where a student can flip the language
          toggle while an existing reply's picker is already mounted. */}
      <PatternPicker
        key={`${topicId}:${preferEnglish}`}
        topicId={topicId}
        preferEnglish={preferEnglish}
        onExerciseGenerated={handleExerciseGenerated}
      />
    </div>
  );
}
