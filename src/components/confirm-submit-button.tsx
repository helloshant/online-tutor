"use client";

// A plain <button type="submit"> inside a server action <form> can't run a
// confirm() dialog itself -- that requires a client component. Used for the
// one admin action (deleting a user) destructive enough to warrant a native
// confirm, unlike the rest of the panel's delete buttons.
export function ConfirmSubmitButton({
  confirmMessage,
  className,
  children,
}: {
  confirmMessage: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(e) => {
        if (!confirm(confirmMessage)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
