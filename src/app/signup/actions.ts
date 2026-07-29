"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { SIGNUP_CAMPAIGN_COOKIE, SIGNUP_SOURCE_COOKIE } from "@/lib/attribution";

export interface SignupState {
  error?: string;
  message?: string;
}

export async function signup(_prevState: SignupState, formData: FormData): Promise<SignupState> {
  const fullName = String(formData.get("fullName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!fullName || !email || !password) {
    return { error: "Please fill in every field." };
  }
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  // Set by src/proxy.ts on first touch -- forwarded into raw_user_meta_data
  // here so the handle_new_tutorops_user() trigger can persist it onto the
  // new profile row (see supabase/migrations/0022_signup_source.sql).
  const cookieStore = await cookies();
  const signupSource = cookieStore.get(SIGNUP_SOURCE_COOKIE)?.value;
  const signupCampaign = cookieStore.get(SIGNUP_CAMPAIGN_COOKIE)?.value;

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName, signup_source: signupSource, signup_campaign: signupCampaign } },
  });

  if (error) {
    return { error: error.message };
  }

  if (!data.session) {
    return {
      message: "Account created. Check your email to confirm it, then log in.",
    };
  }

  redirect("/onboarding");
}
