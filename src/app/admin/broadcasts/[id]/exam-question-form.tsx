"use client";

import { useActionState, useState } from "react";
import { addExamQuestion, type AddExamQuestionState } from "../actions";

const initialState: AddExamQuestionState = {};

export function ExamQuestionForm({ broadcastId }: { broadcastId: string }) {
  const addQuestion = addExamQuestion.bind(null, broadcastId);
  const [state, formAction, pending] = useActionState(addQuestion, initialState);
  // Same "bump a generation counter, key the fields off it" reset pattern
  // as QuestionForm (question-form.tsx) -- see that file's own comment for
  // why this uses state, not a ref.
  const [generation, setGeneration] = useState(0);
  const [lastState, setLastState] = useState(state);
  if (state !== lastState) {
    setLastState(state);
    if (state?.success) setGeneration((g) => g + 1);
  }

  return (
    <form action={formAction} className="space-y-2 rounded-lg border border-dashed border-border p-3">
      <textarea
        key={`question-${generation}`}
        name="question"
        placeholder="Question text (as it appears on the paper)"
        rows={2}
        required
        className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
      />
      <div className="flex items-center gap-2">
        <label className="text-xs text-foreground/60">
          Max marks{" "}
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
