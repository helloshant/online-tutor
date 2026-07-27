"use server";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";

export interface ForgotPasswordState {
  error?: string;
  message?: string;
}

const GENERIC_MESSAGE =
  "If an account exists for that email, we've sent a link to reset your password.";

export async function requestPasswordReset(
  _prevState: ForgotPasswordState,
  formData: FormData
): Promise<ForgotPasswordState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) {
    return { error: "Enter your email." };
  }

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const protocol = h.get("x-forwarded-proto") ?? "http";
  const origin = `${protocol}://${host}`;

  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/callback?next=/reset-password`,
  });

  // Same message whether or not the email is registered -- confirming or
  // denying an account's existence here would let this form be used to
  // enumerate registered emails.
  return { message: GENERIC_MESSAGE };
}
