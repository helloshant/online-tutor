import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AnswerFeedbackKind, AnswerFeedbackRating } from "@/lib/supabase/types";

const KINDS: AnswerFeedbackKind[] = ["chat_message", "topic_summary", "exercise"];
const RATINGS: AnswerFeedbackRating[] = ["up", "down"];

// Generous but bounded -- this is a full chat reply or topic summary, not a
// short comment, but nothing here needs to keep growing without limit.
const MAX_SNAPSHOT_LENGTH = 4000;
const MAX_NOTE_LENGTH = 1000;
const MAX_QUESTION_LENGTH = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    return await handlePost(request);
  } catch (err) {
    console.error("Unexpected error in POST /api/feedback:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

async function handlePost(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const kind = body?.kind;
  const rating = body?.rating;
  const contentSnapshot = typeof body?.contentSnapshot === "string" ? body.contentSnapshot.trim() : "";

  if (!KINDS.includes(kind)) {
    return NextResponse.json({ error: "Invalid feedback kind." }, { status: 400 });
  }
  if (!RATINGS.includes(rating)) {
    return NextResponse.json({ error: "Invalid rating." }, { status: 400 });
  }
  if (!contentSnapshot) {
    return NextResponse.json({ error: "Nothing to attach this feedback to." }, { status: 400 });
  }

  const targetId = typeof body?.targetId === "string" && UUID_RE.test(body.targetId) ? body.targetId : null;
  const subjectId = typeof body?.subjectId === "string" && UUID_RE.test(body.subjectId) ? body.subjectId : null;
  const question =
    typeof body?.question === "string" && body.question.trim() ? body.question.trim().slice(0, MAX_QUESTION_LENGTH) : null;
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, MAX_NOTE_LENGTH) : null;

  const admin = createAdminClient();

  // At most one *open* vote per student per (kind, target_id) -- rather than
  // a DB constraint (a content_snapshot this size can't sit in a unique
  // index, see 0031_answer_feedback.sql), a student flipping their vote (or
  // re-clicking the same one) just replaces their existing row for this
  // exact thing. Only meaningful when target_id is present (a chat message
  // always has one; a topic summary/exercise vote is keyed on the topic,
  // also always present from the client) -- skipped, not an error, on the
  // rare case a caller omits it.
  if (targetId) {
    const { error: deleteError } = await admin
      .from("answer_feedback")
      .delete()
      .eq("user_id", user.id)
      .eq("kind", kind)
      .eq("target_id", targetId);
    if (deleteError) {
      console.error("Failed to clear previous feedback before re-recording:", deleteError);
    }
  }

  const { error } = await admin.from("answer_feedback").insert({
    user_id: user.id,
    kind,
    target_id: targetId,
    subject_id: subjectId,
    question,
    content_snapshot: contentSnapshot.slice(0, MAX_SNAPSHOT_LENGTH),
    rating,
    note,
  });

  if (error) {
    console.error("Failed to record answer feedback:", error);
    return NextResponse.json({ error: "Could not save your feedback." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
