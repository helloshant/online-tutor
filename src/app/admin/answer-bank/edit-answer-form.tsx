"use client";

import { useActionState, useEffect, useRef } from "react";
import { editAnswer, type AnswerBankScope, type EditAnswerState } from "./actions";

const initialState: EditAnswerState = {};

// The only client component on this otherwise all-server-actions page --
// needed because closing the <details> disclosure after a successful save
// requires knowing the save actually landed (see editAnswer's comment for
// why a plain <form action={...}> can't do that on its own).
export function EditAnswerForm({
  scope,
  question,
  answer,
}: {
  scope: AnswerBankScope;
  question: string;
  answer: string;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [state, formAction, pending] = useActionState(editAnswer.bind(null, scope), initialState);

  useEffect(() => {
    if (state.success && detailsRef.current) {
      detailsRef.current.open = false;
    }
  }, [state]);

  return (
    <details ref={detailsRef} className="mt-2">
      <summary className="cursor-pointer text-xs font-medium text-brand hover:underline">
        Edit question/answer
      </summary>
      <form action={formAction} className="mt-2 space-y-2">
        <textarea
          name="question"
          defaultValue={question}
          rows={2}
          required
          className="w-full rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-sm"
        />
        <textarea
          name="answer"
          defaultValue={answer}
          rows={4}
          placeholder="Leave blank for an image-only answer"
          className="w-full rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-sm"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-dark disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </form>
    </details>
  );
}
