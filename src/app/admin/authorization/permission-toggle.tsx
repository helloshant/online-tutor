"use client";

import { useState, useTransition } from "react";
import { setPagePermission } from "./actions";
import type { AdminPageKey } from "@/lib/supabase/types";

export function PermissionToggle({
  userId,
  page,
  granted,
}: {
  userId: string;
  page: AdminPageKey;
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
          await setPagePermission(userId, page, next);
        });
      }}
      className="h-4 w-4 rounded border-border accent-brand disabled:opacity-50"
      aria-label={`${granted ? "Revoke" : "Grant"} ${page} access`}
    />
  );
}
