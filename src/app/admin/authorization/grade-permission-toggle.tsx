"use client";

import { useState, useTransition } from "react";
import { setGradePermission } from "./actions";

// Same optimistic-update pattern as PermissionToggle (permission-toggle.tsx)
// -- kept as a separate component rather than generalizing that one, since
// the two toggle genuinely different tables with opposite "empty" meanings
// (see setGradePermission's own comment).
export function GradePermissionToggle({
  userId,
  gradeId,
  granted,
}: {
  userId: string;
  gradeId: string;
  granted: boolean;
}) {
  const [checked, setChecked] = useState(granted);
  const [isPending, startTransition] = useTransition();

  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={isPending}
      onChange={(e) => {
        const next = e.target.checked;
        setChecked(next);
        startTransition(async () => {
          await setGradePermission(userId, gradeId, next);
        });
      }}
      className="h-4 w-4 rounded border-border accent-brand disabled:opacity-50"
      aria-label={`${granted ? "Revoke" : "Grant"} this grade`}
    />
  );
}
