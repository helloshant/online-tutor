"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { establishSingleSession } from "@/lib/singleSession";

export interface LoginState {
  error?: string;
}

export async function login(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/dashboard");

  if (!email || !password) {
    return { error: "Enter both email and password." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { error: error.message };
  }

  // Makes this login the account's one active device -- see that
  // function's own comment. Awaited before redirect so the very first
  // page this device loads already reflects it.
  await establishSingleSession(supabase, data.user.id);

  redirect(next.startsWith("/") ? next : "/dashboard");
}
