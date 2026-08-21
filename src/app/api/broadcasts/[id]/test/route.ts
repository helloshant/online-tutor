import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await handleGet(await params);
  } catch (err) {
    console.error("Unexpected error in GET /api/broadcasts/[id]/test:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

// Fetching the test also starts it (creates the test_attempts row if one
// doesn't exist yet) -- there's no separate "start" step, since starting is
// a trivial insert with nothing privileged about it (unlike submitting,
// which needs services/broadcast's own auto-grading -- see
// broadcastClient.ts). A student who reloads mid-test gets their existing
// in-progress attempt back rather than a fresh one, thanks to the
// unique(broadcast_id, user_id) constraint + ignoreDuplicates below.
async function handleGet({ id: broadcastId }: { id: string }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const admin = createAdminClient();

  const [{ data: recipient }, { data: broadcast }] = await Promise.all([
    admin.from("broadcast_recipients").select("id").eq("broadcast_id", broadcastId).eq("user_id", user.id).maybeSingle(),
    admin.from("broadcasts").select("type").eq("id", broadcastId).maybeSingle(),
  ]);
  if (!recipient) {
    return NextResponse.json({ error: "This wasn't sent to you." }, { status: 403 });
  }
  if (!broadcast || broadcast.type !== "test") {
    return NextResponse.json({ error: "This isn't a test." }, { status: 400 });
  }

  await admin
    .from("test_attempts")
    .upsert({ broadcast_id: broadcastId, user_id: user.id }, { onConflict: "broadcast_id,user_id", ignoreDuplicates: true });

  const { data: attempt, error: attemptError } = await admin
    .from("test_attempts")
    .select("id, status, total_score, max_possible_score, submitted_at")
    .eq("broadcast_id", broadcastId)
    .eq("user_id", user.id)
    .single();
  if (attemptError || !attempt) {
    return NextResponse.json({ error: "Could not start the test." }, { status: 500 });
  }

  // correct_option is deliberately never selected here -- this response
  // reaches the student's own browser, so the answer key must never be in
  // it (see test_questions' own column comment in the migration).
  const { data: questions } = await admin
    .from("test_questions")
    .select("id, question_type, question, options, max_score, sort_order")
    .eq("broadcast_id", broadcastId)
    .order("sort_order");

  // Once submitted, hand back what was actually answered/scored too, so a
  // reload shows results instead of a blank form.
  let answers: { question_id: string; selected_option: number | null; answer_text: string | null; score: number | null }[] = [];
  if (attempt.status !== "in_progress") {
    const { data } = await admin
      .from("test_answers")
      .select("question_id, selected_option, answer_text, score")
      .eq("attempt_id", attempt.id);
    answers = data ?? [];
  }

  return NextResponse.json({ attempt, questions: questions ?? [], answers });
}
