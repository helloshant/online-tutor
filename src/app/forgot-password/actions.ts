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
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/callback?next=/reset-password`,
  });

  // Supabase's own API already absorbs the "no account with this email"
  // case silently (no error) specifically to prevent enumeration -- that
  // protection happens on their end regardless of what this action does,
  // so an `error` reaching here is never "no such account," only a real
  // failure (a dropped connection, the project's redirect-URL allowlist,
  // an email-sending quota/rate limit). Telling the user the truth here
  // doesn't weaken the enumeration protection at all, and claiming success
  // on a genuine failure (the previous behavior) just leaves them checking
  // an inbox that was never going to receive anything, with no way to tell
  // the difference from "check back in a few minutes."
  if (error) {
    console.error("resetPasswordForEmail failed:", error);
    return { error: "Could not send the reset email right now. Please try again in a moment." };
  }

  return { message: GENERIC_MESSAGE };
}
