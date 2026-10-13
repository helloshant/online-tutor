import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { StoredExercise } from "@/lib/supabase/types";

const MAX_EXERCISES = 200;
const EXERCISE_TYPES = new Set(["MCQ", "short_answer", "long_answer", "numerical"]);

function parseExercises(raw: unknown): StoredExercise[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_EXERCISES) return null;
  const parsed: StoredExercise[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const { id, question, answer, type } = item as Record<string, unknown>;
    if (typeof id !== "string" || typeof question !== "string" || typeof answer !== "string") return null;
    if (type !== undefined && type !== null && !EXERCISE_TYPES.has(type as string)) return null;
    parsed.push({ id, question, answer, type: (type as StoredExercise["type"]) ?? null });
  }
  return parsed;
}

// Every code path below must return through NextResponse.json -- this
// top-level catch is the backstop so an unexpected throw never reaches the
// client as an empty/non-JSON body. Same pattern as /api/chat.
export async function PATCH(request: Request, { params }: { params: Promise<{ messageId: string }> }) {
  try {
    return await handlePatch(request, await params);
  } catch (err) {
    console.error("Unexpected error in PATCH /api/chat/[messageId]/exercises:", err);
    return NextResponse.json({ error: "Could not save this to your chat history" }, { status: 500 });
  }
}

// Keeps a persisted chat_messages row's own `exercises` snapshot mirroring
// whatever TopicPractice currently shows underneath it -- called every
// time that combined list changes (a pattern-picker click, "More
// exercises", ...), same trigger chat-panel.tsx's own
// handleTopicExercisesChanged already reacts to for its in-memory copy.
// Works on either a topic_summary bubble's own row or an ordinary
// assistant reply's row -- both carry the same exercises column, see
// 0067_persist_topic_summaries_and_exercises.sql's own comment.
async function handlePatch(request: Request, { messageId }: { messageId: string }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const exercises = parseExercises(body?.exercises);
  if (exercises === null) {
    return NextResponse.json({ error: "exercises must be an array of {id, question, answer, type?}" }, { status: 400 });
  }

  // Ownership re-verified server-side (never trusted from the client
  // beyond which row it's asking to update) -- RLS already lets a student
  // read their own chat_messages rows, so this doubles as the
  // authorization check: a messageId belonging to someone else simply
  // comes back empty.
  const { data: existing } = await supabase
    .from("chat_messages")
    .select("id")
    .eq("id", messageId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }

  // Written with the service-role client -- RLS deliberately allows no
  // client-side writes on chat_messages (see migration 0002), same
  // posture as every other write to this table.
  const admin = createAdminClient();
  const { error } = await admin.from("chat_messages").update({ exercises }).eq("id", messageId);
  if (error) {
    console.error(`Failed to persist exercises onto chat_messages ${messageId}:`, error);
    return NextResponse.json({ error: "Could not save this to your chat history" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
