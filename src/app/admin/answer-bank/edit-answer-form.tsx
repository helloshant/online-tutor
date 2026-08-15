"use client";

import { useActionState, useEffect, useRef } from "react";
import { markersToPlaceholders } from "@/lib/imageMarker";
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
      <form action={formAction} encType="multipart/form-data" className="mt-2 space-y-2">
        <p className="text-xs text-foreground/60">
          <code className="rounded bg-brand/10 px-1 py-0.5">[IMAGE 1]</code>,{" "}
          <code className="rounded bg-brand/10 px-1 py-0.5">[IMAGE 2]</code>, … stand in below for
          this row&apos;s existing images (in the order shown further down) — move one to reposition
          it in the text, or delete its placeholder to leave it trailing at the end as before. A new
          image can be added the same way bulk import does:{" "}
          <code className="rounded bg-brand/10 px-1 py-0.5">IMG: filename.png</code> plus the
          matching file below.
        </p>
        <textarea
          name="question"
          // markersToPlaceholders converts this row's real (invisible)
          // IMAGE_MARKER characters into readable "[IMAGE N]" text purely
          // for display/editing here -- editAnswer converts back on save.
          defaultValue={markersToPlaceholders(question)}
          rows={2}
          required
          className="w-full rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-sm"
        />
        <textarea
          name="answer"
          defaultValue={markersToPlaceholders(answer)}
          rows={4}
          placeholder="Leave blank for an image-only answer"
          className="w-full rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-sm"
        />
        <input
          key={state?.success ? "cleared" : "images"}
          type="file"
          name="images"
          accept="image/*"
          multiple
          className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs file:mr-2 file:rounded file:border-0 file:bg-brand/10 file:px-2 file:py-1 file:text-xs"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-dark disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {state?.unmatchedImageRefs && state.unmatchedImageRefs.length > 0 && (
          <p className="text-xs text-amber-600">
            Couldn&apos;t match: {state.unmatchedImageRefs.join(", ")} — typo, or file not selected
            below?
          </p>
        )}
      </form>
    </details>
  );
}
