import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getTopicExercises, type ExerciseType } from "@/lib/orchestratorClient";
import { toArchetypeGradeOrYear } from "@/lib/archetypeGradeName";
import { resolveResponseLanguage } from "@/lib/studentScope";
import { resolveUsageLimit } from "@/lib/usageLimits";
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

  const [{ data: board }, { data: grade }, { data: subject }, { data: subscription }] = await Promise.all([
    supabase.from("boards").select("name").eq("id", topicRow.board_id).single(),
    supabase.from("grades").select("name").eq("id", topicRow.grade_id).single(),
    supabase.from("subjects").select("name, code").eq("id", topicRow.subject_id).single(),
    // Includes a trial (pending_payment) subscription, not just a paid
    // (active) one -- same as /api/topics/[id]/summary's own lookup.
    supabase.from("subscriptions").select("medium, status").eq("user_id", user.id).in("status", ["active", "pending_payment"]).maybeSingle(),
  ]);

  const topicMedium = topicRow.medium as Medium;
  const nativeMedium: Medium = (subscription?.medium as Medium | undefined) ?? topicMedium;

  // Unlike a "Generate another"/regenerate click (see
  // /api/topics/[id]/exercises/generate/route.ts), an INITIAL batch here
  // has deliberately never been usage-capped for a paying student -- that
  // stays unchanged. But a trial (pending_payment) student picking topic
  // after topic in the sidebar is exactly the path this route serves, and
  // with no cap check here at all, it would fully bypass the free-trial
  // allowance (chat/generate/practice-papers all check it, but simply
  // browsing topics never would). So this checks it ONLY for a trial
  // subscription, leaving every other case (active, staff, no
  // subscription) exactly as uncapped as before.
  if (subscription?.status === "pending_payment") {
    const admin = createAdminClient();
    const { data: override } = await admin
      .from("student_usage_limits")
      .select("monthly_token_limit")
      .eq("user_id", user.id)
      .maybeSingle();
    const { unlimited, limit, sinceIso, exceededMessage } = resolveUsageLimit("pending_payment", override);
    if (!unlimited) {
      const { data: usedTokens, error: usageError } = await admin.rpc("monthly_llm_tokens_for_user", {
        p_user_id: user.id,
        p_since: sinceIso,
      });
      if (usageError) {
        console.error("Failed to check trial token usage, allowing the request:", usageError);
      } else if ((usedTokens ?? 0) >= limit) {
        return NextResponse.json({ error: exceededMessage }, { status: 429 });
      }
    }
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
