"use server";

import { createClient } from "@/lib/supabase/server";
import type { ResetPasswordState } from "@/app/reset-password/actions";

// Same core operation as reset-password/actions.ts's own resetPassword
// (same validation, same supabase.auth.updateUser({ password }) call,
// same auto-stamped profiles.password_changed_at trigger) -- kept as its
// own action rather than reused directly because this one stays on the
// account page and returns a success message instead of redirect()ing to
// /dashboard, which would be the wrong outcome for a page the user is
// already on and likely wants to keep using afterward.
export async function changePassword(
  _prevState: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (password !== confirmPassword) {
    return { error: "Passwords don't match." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    return { error: error.message };
  }

  return { success: true };
}
