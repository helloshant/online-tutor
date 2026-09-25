"use client";

import { useActionState } from "react";
import { addEmphasisToChapterDocument, type AddEmphasisState } from "./actions";

const initialState: AddEmphasisState = {};

// One document's retrofit trigger, next to Delete in the list row (see
// page.tsx). Not folded into EditChapterDocumentForm's own Save button --
// this doesn't open the edit disclosure or touch the textarea's draft
// value, it acts directly on the saved row, same as Delete does.
export function AddEmphasisButton({ id }: { id: string }) {
  const [state, formAction, pending] = useActionState(addEmphasisToChapterDocument.bind(null, id), initialState);

  return (
    <form action={formAction} className="inline-block">
      <button type="submit" disabled={pending} className="text-xs font-medium text-brand hover:underline disabled:opacity-60">
        {pending ? "Adding emphasis…" : "Add emphasis"}
      </button>
      {state.error && <p className="mt-1 text-xs text-red-600">{state.error}</p>}
      {state.success && (
        <p className="mt-1 text-xs text-foreground/68">
          {!state.verifiedChunks && !state.failedChunks
            ? "Nothing to change."
            : !state.verifiedChunks
              ? "Couldn't safely format this one -- left unchanged."
              : `Formatted${state.failedChunks ? ` (${state.failedChunks} section${state.failedChunks === 1 ? "" : "s"} left unchanged, couldn't verify safely)` : ""}.`}
          {state.embedWarning && " Couldn't re-index it for search right now."}
        </p>
      )}
    </form>
  );
}
