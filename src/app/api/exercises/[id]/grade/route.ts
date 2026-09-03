import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gradeTopicExercise } from "@/lib/orchestratorClient";

const MAX_ANSWER_LENGTH = 4000;

// Every code path below must return through NextResponse.json -- this
// top-level catch is the backstop so an unexpected throw never reaches the
// client as an empty/non-JSON body. Same pattern as /api/chat.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await handlePost(request, await params);
  } catch (err) {
    console.error("Unexpected error in POST /api/exercises/[id]/grade:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

async function handlePost(request: Request, { id: exerciseId }: { id: string }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const studentAnswer = typeof body?.answer === "string" ? body.answer.trim() : "";

  if (!studentAnswer) {
    return NextResponse.json({ error: "answer is required" }, { status: 400 });
  }
  if (studentAnswer.length > MAX_ANSWER_LENGTH) {
    return NextResponse.json({ error: "Your answer is too long." }, { status: 400 });
  }

  try {
    const graded = await gradeTopicExercise({
      userId: user.id,
      exerciseId,
      studentAnswer,
    });
    return NextResponse.json(graded);
  } catch (err) {
    console.error("Exercise grading request failed:", err);
    return NextResponse.json({ error: "Could not grade this attempt right now. Please try again shortly." }, { status: 502 });
  }
}
