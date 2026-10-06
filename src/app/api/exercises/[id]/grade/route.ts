import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isStaff } from "@/lib/auth";
import { gradeTopicExercise } from "@/lib/orchestratorClient";
import { getWalletBalance, WALLET_EXHAUSTED_MESSAGE } from "@/lib/walletBalance";

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

  // Wallet gate -- this route had no usage check at all before the wallet
  // model (a real gap, same as /api/practice-papers/[id]/submit), closed
  // here. Staff stay unmetered, same posture as every other LLM-spending
  // route.
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  let provider: "gemini" | "anthropic" | undefined;
  if (!isStaff(profile?.role)) {
    const wallet = await getWalletBalance(admin, user.id);
    if (wallet.balance <= 0) {
      return NextResponse.json(
        { error: WALLET_EXHAUSTED_MESSAGE },
        { status: 429 },
      );
    }
    provider = wallet.provider;
  }

  try {
    const graded = await gradeTopicExercise({
      userId: user.id,
      exerciseId,
      studentAnswer,
      provider,
    });
    return NextResponse.json(graded);
  } catch (err) {
    console.error("Exercise grading request failed:", err);
    return NextResponse.json({ error: "Could not grade this attempt right now. Please try again shortly." }, { status: 502 });
  }
}
