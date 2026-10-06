import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isStaff } from "@/lib/auth";
import { getTopicExercises, type ExerciseType } from "@/lib/orchestratorClient";
import { toArchetypeGradeOrYear } from "@/lib/archetypeGradeName";
import { resolveResponseLanguage } from "@/lib/studentScope";
import { getWalletBalance, WALLET_EXHAUSTED_MESSAGE } from "@/lib/walletBalance";
import type { Medium } from "@/lib/supabase/types";

// Same as generate-for-concept/route.ts's own VALID_TYPES -- an unknown/
// missing value on the query string is silently treated as "no
// preference" (undefined) rather than rejected, same posture that route
// already takes.
const VALID_TYPES: ExerciseType[] = ["MCQ", "short_answer", "long_answer", "numerical"];

// Every code path below must return through NextResponse.json -- this
// top-level catch is the backstop so an unexpected throw never reaches the
// client as an empty/non-JSON body. Same pattern as /api/chat.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await handleGetExercises(request, await params);
  } catch (err) {
    console.error("Unexpected error in GET /api/topics/[id]/exercises:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

async function handleGetExercises(request: Request, { id: topicId }: { id: string }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const url = new URL(request.url);
  const preferEnglish = url.searchParams.get("preferEnglish") === "true";
  // Set only when the student picked a sub-topic pill (see
  // /api/topics/[id]/exercises/subtopics) rather than "all exercises for
  // this chapter" -- narrows generation to just that sub-topic, see
  // getTopicExercises/the orchestrator's own TopicExercisesRequest comment.
  const subTopic = url.searchParams.get("subTopic") ?? undefined;
  // Set only by the "More exercises" action on an already-loaded flat
  // batch -- see getTopicExercises/the orchestrator's own
  // TopicExercisesRequest comment for why this is needed.
  const forceFresh = url.searchParams.get("forceFresh") === "true";
  // Set only by the "More exercises" action's own type picker -- see
  // getTopicExercises/the orchestrator's own TopicExercisesRequest
  // comment for why this implies forceFresh too.
  const requestedTypeParam = url.searchParams.get("requestedType");
  const requestedType = VALID_TYPES.includes(requestedTypeParam as ExerciseType)
    ? (requestedTypeParam as ExerciseType)
    : undefined;

  const { data: topicRow } = await supabase
    .from("syllabus_topics")
    .select("board_id, grade_id, subject_id, medium, chapter, topic")
    .eq("id", topicId)
    .maybeSingle();

  if (!topicRow) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  const [{ data: board }, { data: grade }, { data: subject }, { data: profile }, { data: subscription }] = await Promise.all([
    supabase.from("boards").select("name").eq("id", topicRow.board_id).single(),
    supabase.from("grades").select("name").eq("id", topicRow.grade_id).single(),
    supabase.from("subjects").select("name, code").eq("id", topicRow.subject_id).single(),
    supabase.from("profiles").select("role").eq("id", user.id).single(),
    supabase.from("subscriptions").select("medium, status").eq("user_id", user.id).eq("status", "active").maybeSingle(),
  ]);

  const staff = isStaff(profile?.role);
  const topicMedium = topicRow.medium as Medium;
  // Staff never subscribe, and ignore their own subscription row entirely
  // even if one happens to exist -- see summary/route.ts's own comment on
  // the exact bug (a staff account's leftover personal trial subscription
  // silently overriding the board/grade/medium they're actually staff-
  // previewing) this guards against, confirmed directly against a real
  // account.
  const nativeMedium: Medium = staff ? topicMedium : ((subscription?.medium as Medium | undefined) ?? topicMedium);

  // Wallet gate, same as every other LLM-spending route -- unlike the old
  // monthly-cap model, there's no more "paying students are uncapped on
  // the initial batch" exception to carry over: every student spends from
  // the same wallet regardless of which route the spend came from.
  let provider: "gemini" | "anthropic" | undefined;
  if (!staff) {
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

  // See the matching comment in /api/topics/[id]/summary/route.ts and
  // /api/chat/route.ts -- medium always stays this topic's own real content
  // medium; responseLanguage independently decides what language the
  // exercises are generated/served in -- see resolveResponseLanguage's own
  // comment in studentScope.ts for the full rule.
  const responseLanguage: Medium = resolveResponseLanguage(subject?.code ?? "", nativeMedium, preferEnglish);

  try {
    const { exercises } = await getTopicExercises({
      userId: user.id,
      topicId,
      boardId: topicRow.board_id,
      gradeId: topicRow.grade_id,
      subjectId: topicRow.subject_id,
      subjectName: subject?.name ?? "",
      boardName: board?.name ?? "",
      // See toArchetypeGradeOrYear's own comment -- grades.name ("Grade
      // N") never matches archetype education_context.grade_or_year ("N")
      // unstripped, which meant every archetype-grounded generation
      // through this route silently fell back to the ungrounded prompt
      // regardless of real mining coverage.
      gradeName: toArchetypeGradeOrYear(grade?.name ?? ""),
      medium: topicMedium,
      responseLanguage,
      chapter: topicRow.chapter,
      topic: topicRow.topic,
      subTopic,
      forceFresh,
      requestedType,
      provider,
    });
    return NextResponse.json({ exercises });
  } catch (err) {
    console.error("Topic exercises request failed:", err);
    return NextResponse.json(
      { error: "Could not load exercises. Please try again shortly." },
      { status: 502 }
    );
  }
}
