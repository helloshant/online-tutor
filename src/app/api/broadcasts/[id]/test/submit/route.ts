import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { submitTest } from "@/lib/broadcastClient";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await handlePost(request, await params);
  } catch (err) {
    console.error("Unexpected error in POST /api/broadcasts/[id]/test/submit:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

async function handlePost(request: Request, { id: broadcastId }: { id: string }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!Array.isArray(body?.answers)) {
    return NextResponse.json({ error: "answers array is required" }, { status: 400 });
  }

  // Cheap ownership check before handing off -- services/broadcast is the
  // actual trust boundary for what gets recorded (it re-verifies the
  // attempt itself, see grading.ts), but there's no reason to make that
  // round trip for a student who was never sent this test at all.
  const admin = createAdminClient();
  const { data: recipient } = await admin
    .from("broadcast_recipients")
    .select("id")
    .eq("broadcast_id", broadcastId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!recipient) {
    return NextResponse.json({ error: "This wasn't sent to you." }, { status: 403 });
  }

  try {
    const result = await submitTest(broadcastId, user.id, body.answers);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not submit the test." }, { status: 400 });
  }
}
