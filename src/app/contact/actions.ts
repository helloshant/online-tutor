"use server";

import { createClient } from "@/lib/supabase/server";

export interface CallbackRequestState {
  error?: string;
  success?: boolean;
}

// Public, unauthenticated action -- reached from the Contact page before a
// visitor has necessarily signed up at all, same posture as signup() in
// src/app/signup/actions.ts. Uses the ordinary (anon-key) session client,
// not the admin one: callback_requests' own RLS policy is what actually
// authorizes this insert (see 0051_callback_requests.sql's own comment on
// why it's a public-insert, admin-only-read table), not service-role
// bypass.
export async function submitCallbackRequest(
  _prevState: CallbackRequestState,
  formData: FormData,
): Promise<CallbackRequestState> {
  const name = String(formData.get("name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const message = String(formData.get("message") ?? "").trim();

  if (!name || !phone) {
    return { error: "Please enter your name and phone number." };
  }
  // Lenient on purpose -- this only guards against an empty/junk submission,
  // not a strict phone-format validator (real numbers arrive with spaces,
  // +91, hyphens, etc., none of which is this form's business to reject).
  const digitCount = phone.replace(/\D/g, "").length;
  if (digitCount < 8) {
    return { error: "Please enter a valid phone number." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("callback_requests").insert({
    name,
    phone,
    message: message || null,
  });

  if (error) {
    return { error: "Could not submit your request. Please try again." };
  }

  return { success: true };
}
