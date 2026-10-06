import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isStaff } from "@/lib/auth";
import { getWalletBalance, WALLET_EXHAUSTED_MESSAGE } from "@/lib/walletBalance";
import {
  generateTopicExercise,
  type DifficultyLevel,
  type ExerciseType,
} from "@/lib/orchestratorClient";
import { toArchetypeGradeOrYear } from "@/lib/archetypeGradeName";
import { resolveResponseLanguage } from "@/lib/studentScope";
import type { Medium } from "@/lib/supabase/types";

const VALID_DIFFICULTIES: DifficultyLevel[] = ["Easy", "Medium", "Hard"];
const VALID_TYPES: ExerciseType[] = [
  "MCQ",
  "short_answer",
  "long_answer",
  "numerical",
];

// On-demand generation for ONE specific pattern (Tier C's "Generate" on a
// picked pattern, or "Generate another" with no pattern specified) --
// unlike GET /api/topics/[id]/exercises (which only ever fires once per
// topic-open), this can be clicked repeatedly, so it's the one exercise-
// generation endpoint that actually needs the same wallet gate /api/chat
// already enforces -- see the wallet-balance check below.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    return await handlePost(request, await params);
  } catch (err) {
    console.error(
      "Unexpected error in POST /api/topics/[id]/exercises/generate:",
      err,
    );
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 },
    );
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
  const archetypeId =
    typeof body?.archetypeId === "string" ? body.archetypeId : undefined;
  const archetypeRunId =
    typeof body?.archetypeRunId === "string" ? body.archetypeRunId : undefined;
  const preferEnglish = body?.preferEnglish === true;
  // Set only when this "Generate"/"Generate another" click happened
  // underneath an already-selected sub-topic pill -- see
  // GenerateTopicExerciseRequest.subTopic's own comment for why this has
  // to be threaded through here too, not just the initial exercises list.
  const subTopic =
    typeof body?.subTopic === "string" ? body.subTopic : undefined;
  // Invalid/absent just means "Any difficulty" -- never a 400, this is
  // the one optional refinement on an otherwise already-valid request.
  const requestedDifficulty = VALID_DIFFICULTIES.includes(
    body?.requestedDifficulty,
  )
    ? (body.requestedDifficulty as DifficultyLevel)
    : undefined;
  // Invalid/absent just means "Any type" -- same posture as
  // requestedDifficulty above.
  const requestedType = VALID_TYPES.includes(body?.requestedType)
    ? (body.requestedType as ExerciseType)
    : undefined;

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  // Fetched once, up front, for this route's own `medium` need further
  // down -- status is no longer meaningful here (subject selection is free
  // and instant, see onboarding/actions.ts), so this no longer filters on
  // it.
  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("medium, status")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();

  // Wallet gate -- staff stay unmetered (same posture every other route
  // with this check already gives them), a real student's balance is
  // checked exactly the way /api/chat checks it, before the orchestrator
  // is ever called, so an exhausted-wallet click never spends anything on
  // a fresh LLM call.
  let provider: "gemini" | "anthropic" | undefined;
  if (!isStaff(profile?.role)) {
    const admin = createAdminClient();
    const wallet = await getWalletBalance(admin, user.id);
    if (wallet.balance <= 0) {
      return NextResponse.json(
        { error: WALLET_EXHAUSTED_MESSAGE },
        { status: 429 },
      );
    }
    provider = wallet.provider;
  }

  const { data: topicRow } = await supabase
    .from("syllabus_topics")
    .select("board_id, grade_id, subject_id, medium, chapter, topic")
    .eq("id", topicId)
    .maybeSingle();

  if (!topicRow) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  const [{ data: board }, { data: grade }, { data: subject }] =
    await Promise.all([
      supabase.from("boards").select("name").eq("id", topicRow.board_id).single(),
      supabase.from("grades").select("name").eq("id", topicRow.grade_id).single(),
      supabase
        .from("subjects")
        .select("name, code")
        .eq("id", topicRow.subject_id)
        .single(),
    ]);

  const topicMedium = topicRow.medium as Medium;
  // Staff never subscribe, and ignore their own subscription row entirely
  // even if one happens to exist -- see
  // /api/topics/[id]/summary/route.ts's own comment on the exact bug (a
  // staff account's leftover personal trial subscription silently
  // overriding the board/grade/medium they're actually staff-previewing)
  // this guards against.
  const nativeMedium: Medium = isStaff(profile?.role)
    ? topicMedium
    : ((subscription?.medium as Medium | undefined) ?? topicMedium);

  // Same responseLanguage resolution as GET /api/topics/[id]/exercises --
  // see that route's own comment.
  const responseLanguage: Medium = resolveResponseLanguage(
    subject?.code ?? "",
    nativeMedium,
    preferEnglish,
  );

  try {
    const { exercise } = await generateTopicExercise({
      userId: user.id,
      topicId,
      boardId: topicRow.board_id,
      gradeId: topicRow.grade_id,
      subjectId: topicRow.subject_id,
      subjectName: subject?.name ?? "",
      boardName: board?.name ?? "",
      // See toArchetypeGradeOrYear's own comment -- grades.name ("Grade
      // N") never matches archetype education_context.grade_or_year ("N")
      // unstripped.
      gradeName: toArchetypeGradeOrYear(grade?.name ?? ""),
      medium: topicMedium,
      responseLanguage,
      chapter: topicRow.chapter,
      topic: topicRow.topic,
      subTopic,
      archetypeId,
      archetypeRunId,
      requestedDifficulty,
      requestedType,
      provider,
    });
    return NextResponse.json({ exercise });
  } catch (err) {
    console.error("On-demand topic exercise generation request failed:", err);
    return NextResponse.json(
      {
        error:
          "Could not generate a question right now. Please try again shortly.",
      },
      { status: 502 },
    );
  }
}
