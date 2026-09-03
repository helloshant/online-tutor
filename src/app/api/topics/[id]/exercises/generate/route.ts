import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isStaff } from "@/lib/auth";
import { resolveMonthlyTokenLimit, startOfCurrentMonthIso } from "@/lib/usageLimits";
import { generateTopicExercise } from "@/lib/orchestratorClient";
import type { Medium } from "@/lib/supabase/types";

// Mirrors ENGLISH_SUBJECT_CODE in /api/chat/route.ts and
// /api/topics/[id]/exercises/route.ts.
const ENGLISH_SUBJECT_CODE = "ENG";

// On-demand generation for ONE specific pattern (Tier C's "Generate" on a
// picked pattern, or "Generate another" with no pattern specified) --
// unlike GET /api/topics/[id]/exercises (which only ever fires once per
// topic-open), this can be clicked repeatedly, so it's the one exercise-
// generation endpoint that actually needs the same monthly-token-usage
// gate /api/chat already enforces -- see the usage-quota block below.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await handlePost(request, await params);
  } catch (err) {
    console.error("Unexpected error in POST /api/topics/[id]/exercises/generate:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

async function handlePost(request: Request, { id: topicId }: { id: string }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const archetypeId = typeof body?.archetypeId === "string" ? body.archetypeId : undefined;
  const archetypeRunId = typeof body?.archetypeRunId === "string" ? body.archetypeRunId : undefined;
  const preferEnglish = body?.preferEnglish === true;

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();

  // Usage-based pricing enforcement -- staff stay unmetered (same posture
  // every other route with a quota check already gives them), a real
  // student's monthly token cap is checked exactly the way /api/chat
  // checks it, before the orchestrator is ever called, so an over-quota
  // click never spends anything on a fresh LLM call.
  if (!isStaff(profile?.role)) {
    const admin = createAdminClient();
    const { data: override } = await admin
      .from("student_usage_limits")
      .select("monthly_token_limit")
      .eq("user_id", user.id)
      .maybeSingle();

    const { unlimited, limit } = resolveMonthlyTokenLimit(override);

    if (!unlimited) {
      const { data: usedTokens, error: usageError } = await admin.rpc("monthly_llm_tokens_for_user", {
        p_user_id: user.id,
        p_since: startOfCurrentMonthIso(),
      });
      if (usageError) {
        // Fail OPEN on a metering error, same reasoning as /api/chat --
        // blocking every request because the usage lookup itself failed
        // would be a worse outage than occasionally under-enforcing a cap.
        console.error("Failed to check monthly token usage, allowing the request:", usageError);
      } else if ((usedTokens ?? 0) >= limit) {
        return NextResponse.json(
          { error: "You've reached this month's AI tutoring usage limit. It resets at the start of next month." },
          { status: 429 }
        );
      }
    }
  }

  const { data: topicRow } = await supabase
    .from("syllabus_topics")
    .select("board_id, grade_id, subject_id, medium, chapter, topic")
    .eq("id", topicId)
    .maybeSingle();

  if (!topicRow) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  const [{ data: board }, { data: grade }, { data: subject }, { data: subscription }] = await Promise.all([
    supabase.from("boards").select("name").eq("id", topicRow.board_id).single(),
    supabase.from("grades").select("name").eq("id", topicRow.grade_id).single(),
    supabase.from("subjects").select("name, code").eq("id", topicRow.subject_id).single(),
    supabase.from("subscriptions").select("medium").eq("user_id", user.id).eq("status", "active").maybeSingle(),
  ]);

  const isEnglishSubject = subject?.code === ENGLISH_SUBJECT_CODE;
  const topicMedium = topicRow.medium as Medium;
  const nativeMedium: Medium = (subscription?.medium as Medium | undefined) ?? topicMedium;

  // Same responseLanguage resolution as GET /api/topics/[id]/exercises --
  // see that route's own comment.
  const responseLanguage: Medium =
    isEnglishSubject && !preferEnglish && nativeMedium !== topicMedium ? nativeMedium : topicMedium;

  try {
    const { exercise } = await generateTopicExercise({
      userId: user.id,
      topicId,
      boardId: topicRow.board_id,
      gradeId: topicRow.grade_id,
      subjectId: topicRow.subject_id,
      subjectName: subject?.name ?? "",
      boardName: board?.name ?? "",
      gradeName: grade?.name ?? "",
      medium: topicMedium,
      responseLanguage,
      chapter: topicRow.chapter,
      topic: topicRow.topic,
      archetypeId,
      archetypeRunId,
    });
    return NextResponse.json({ exercise });
  } catch (err) {
    console.error("On-demand topic exercise generation request failed:", err);
    return NextResponse.json({ error: "Could not generate a question right now. Please try again shortly." }, { status: 502 });
  }
}
