"use client";

import { useActionState } from "react";
import { setUserPassword, type SetUserPasswordState } from "../../actions";

const initialState: SetUserPasswordState = {};

export function SetPasswordForm({
  userId,
  placeholder,
  submitLabel,
}: {
  userId: string;
  placeholder: string;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(setUserPassword.bind(null, userId), initialState);

  return (
    <div>
      <form action={formAction} className="flex flex-wrap items-end gap-2">
        <input
          key={state?.success ? "cleared" : "input"}
          name="password"
          type="password"
          required
          minLength={8}
          placeholder={placeholder}
          className="min-w-[16rem] flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
        />
        <button
          disabled={pending}
          className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-brand/5 disabled:opacity-60"
        >
          {pending ? "Saving…" : submitLabel}
        </button>
      </form>
      {state?.error && <p className="mt-2 text-sm text-red-600">{state.error}</p>}
      {state?.success && <p className="mt-2 text-sm text-green-600">Password reset successful</p>}
    </div>
  );
}
