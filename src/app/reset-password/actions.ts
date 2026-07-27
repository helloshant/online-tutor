"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export interface ResetPasswordState {
  error?: string;
}

// Shared by both /reset-password (after a recovery-link session) and
// /change-password (an already-authenticated user whose password expired) --
// mechanically it's the same operation, just reached two different ways.
export async function resetPassword(
  _prevState: ResetPasswordState,
  formData: FormData
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

  // profiles.password_changed_at is stamped automatically by the
  // on_tutorops_auth_user_password_change trigger -- no app-side write
  // needed here.
  redirect("/dashboard");
}
