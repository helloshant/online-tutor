import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await handlePost(request, await params);
  } catch (err) {
    console.error("Unexpected error in POST /api/broadcasts/[id]/feedback:", err);
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
  const ratingRaw = body?.rating;
  const rating = typeof ratingRaw === "number" && Number.isFinite(ratingRaw) ? Math.max(1, Math.min(5, Math.round(ratingRaw))) : null;
  const comment = typeof body?.comment === "string" ? body.comment.trim().slice(0, 2000) || null : null;
  if (rating === null && !comment) {
    return NextResponse.json({ error: "Add a rating or a comment." }, { status: 400 });
  }

  const admin = createAdminClient();

  // Re-verified server-side rather than trusted from the client: the
  // student must actually be a recipient of this broadcast, and it must
  // actually be a feedback-type one -- otherwise a crafted request could
  // leave a "feedback" row against a broadcast never sent to them, or
  // against a test/announcement where a rating has no meaning.
  const [{ data: recipient }, { data: broadcast }] = await Promise.all([
    admin.from("broadcast_recipients").select("id").eq("broadcast_id", broadcastId).eq("user_id", user.id).maybeSingle(),
    admin.from("broadcasts").select("type").eq("id", broadcastId).maybeSingle(),
  ]);
  if (!recipient) {
    return NextResponse.json({ error: "This wasn't sent to you." }, { status: 403 });
  }
  if (!broadcast || broadcast.type !== "feedback") {
    return NextResponse.json({ error: "This isn't a feedback request." }, { status: 400 });
  }

  const { error } = await admin
    .from("broadcast_feedback_responses")
    .upsert(
      { broadcast_id: broadcastId, user_id: user.id, rating, comment },
      { onConflict: "broadcast_id,user_id" }
    );
  if (error) {
    console.error("Failed to save feedback response:", error);
    return NextResponse.json({ error: "Could not save your feedback." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
