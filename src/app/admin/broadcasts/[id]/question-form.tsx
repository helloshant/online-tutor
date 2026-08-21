"use client";

import { useActionState, useState } from "react";
import { addTestQuestion, type AddQuestionState } from "../actions";

const initialState: AddQuestionState = {};

// Four option slots, fixed rather than dynamically add/removable -- keeps
// this form simple; an admin who needs more can enter fewer than four
// (blank ones are dropped, see addTestQuestion) or split into two
// questions. Revisit if that turns out to be a real limitation.
const OPTION_SLOTS = [0, 1, 2, 3];

export function QuestionForm({ broadcastId }: { broadcastId: string }) {
  const addQuestion = addTestQuestion.bind(null, broadcastId);
  const [state, formAction, pending] = useActionState(addQuestion, initialState);
  const [questionType, setQuestionType] = useState<"mcq" | "short_answer">("mcq");
  // Bumped on every successful add so the uncontrolled fields below (all
  // keyed off this) remount blank. useActionState hands back a new state
  // object per action call, so comparing identity against the previous one
  // -- tracked in state, not a ref, per React's own documented "storing
  // information from previous renders" pattern (a ref can't be read during
  // render) -- tells us exactly when a fresh submit just resolved, without
  // mutating `state` itself. Same pattern chat-panel.tsx uses for its own
  // render-body state sync.
  const [generation, setGeneration] = useState(0);
  const [lastState, setLastState] = useState(state);
  if (state !== lastState) {
    setLastState(state);
    if (state?.success) setGeneration((g) => g + 1);
  }

  return (
    <form action={formAction} className="space-y-2 rounded-lg border border-dashed border-border p-3">
      <div className="flex gap-3 text-sm">
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="questionType"
            value="mcq"
            checked={questionType === "mcq"}
            onChange={() => setQuestionType("mcq")}
          />
          Multiple choice
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="questionType"
            value="short_answer"
            checked={questionType === "short_answer"}
            onChange={() => setQuestionType("short_answer")}
          />
          Short answer
        </label>
      </div>

      <textarea
        key={`question-${generation}`}
        name="question"
        placeholder="Question text"
        rows={2}
        required
        className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
      />

      {questionType === "mcq" && (
        <div key={`options-${generation}`} className="space-y-1.5">
          {OPTION_SLOTS.map((i) => (
            <div key={i} className="flex items-center gap-2">
              <input type="radio" name="correctOption" value={i} required title="Mark as the correct option" />
              <input
                name="option"
                placeholder={`Option ${i + 1}${i < 2 ? " (required)" : ""}`}
                required={i < 2}
                className="flex-1 rounded-lg border border-border bg-background px-2 py-1 text-sm"
              />
            </div>
          ))}
          <p className="text-xs text-foreground/50">Select the radio button next to the correct option.</p>
        </div>
      )}

      <div className="flex items-center gap-2">
        <label className="text-xs text-foreground/60">
          Max score{" "}
          <input
            key={`maxScore-${generation}`}
            name="maxScore"
            type="number"
            min="1"
            step="1"
            defaultValue={1}
            className="ml-1 w-16 rounded-lg border border-border bg-background px-2 py-1 text-sm"
          />
        </label>
        <button
          disabled={pending}
          className="ml-auto rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-dark disabled:opacity-60"
        >
          {pending ? "Adding…" : "Add question"}
        </button>
      </div>
      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
    </form>
  );
}
