"use client";

import { useActionState } from "react";
import { submitCallbackRequest, type CallbackRequestState } from "./actions";

const initialState: CallbackRequestState = {};

export function CallbackForm() {
  const [state, formAction, pending] = useActionState(submitCallbackRequest, initialState);

  if (state?.success) {
    return (
      <p className="mt-6 rounded-xl border border-border bg-surface p-4 text-sm text-foreground/82">
        Thanks — we&apos;ve got your request and someone from our team will call you back shortly.
      </p>
    );
  }

  return (
    <form action={formAction} className="mt-6 space-y-4">
      <div>
        <label htmlFor="name" className="block text-sm font-medium">
          Name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          autoComplete="name"
          className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
        />
      </div>
      <div>
        <label htmlFor="phone" className="block text-sm font-medium">
          Phone number
        </label>
        <input
          id="phone"
          name="phone"
          type="tel"
          required
          autoComplete="tel"
          className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
        />
      </div>
      <div>
        <label htmlFor="message" className="block text-sm font-medium">
          What&apos;s this about? <span className="font-normal text-foreground/65">(optional)</span>
        </label>
        <textarea
          id="message"
          name="message"
          rows={3}
          className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
        />
      </div>

      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60"
      >
        {pending ? "Submitting…" : "Request Callback"}
      </button>
    </form>
  );
}
