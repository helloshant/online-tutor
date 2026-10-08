"use client";

import { useFormStatus } from "react-dom";

// Gives every form on this page a real pressed/pending state --
// useFormStatus only works inside a <form>, which is why this has to be
// its own client component rather than inline in the (server-rendered)
// forms that use it: reported directly, those forms had no visual
// feedback at all while a Server Action was in flight. `pendingLabel`
// defaults to a generic "Saving…" since every current caller is a save/
// submit action; pass one explicitly for anything that reads oddly with
// that default (e.g. "Cancelling…").
export function SubmitButton({
  children,
  pendingLabel = "Saving…",
  className,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  className: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`${className} disabled:cursor-not-allowed disabled:opacity-60`}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}

// Renders the AdminActionState an action returned via useActionState --
// a brief confirmation or error right under the button it belongs to,
// which these forms previously gave no feedback for at all once the
// Server Action actually finished (silent success and silent no-op
// alike).
export function ActionMessage({
  state,
}: {
  state: { error?: string; success?: string };
}) {
  if (state.error) {
    return <p className="text-xs text-red-600">{state.error}</p>;
  }
  if (state.success) {
    return <p className="text-xs text-green-700">{state.success}</p>;
  }
  return null;
}
