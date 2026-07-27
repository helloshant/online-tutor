import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Shared landing spot for every Supabase Auth flow that redirects back with
// a `code` to exchange for a session: Google OAuth (?next=/dashboard) and
// password-recovery links (?next=/reset-password) both go through here.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";
  const safeNext = next.startsWith("/") ? next : "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${safeNext}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
}
