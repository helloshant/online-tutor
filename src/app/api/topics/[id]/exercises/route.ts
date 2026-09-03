import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTopicExercises } from "@/lib/orchestratorClient";
import { toArchetypeGradeOrYear } from "@/lib/archetypeGradeName";
import type { Medium } from "@/lib/supabase/types";

// Mirrors ENGLISH_SUBJECT_CODE in /api/chat/route.ts.
const ENGLISH_SUBJECT_CODE = "ENG";

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

  const preferEnglish = new URL(request.url).searchParams.get("preferEnglish") === "true";

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

  // See the matching comment in /api/topics/[id]/summary/route.ts and
  // /api/chat/route.ts -- medium always stays this topic's own real content
  // medium; responseLanguage independently decides what language the
  // exercises are generated/served in, defaulting to the student's native
  // medium and only becoming the topic's own medium when the toggle is on.
  const responseLanguage: Medium =
    isEnglishSubject && !preferEnglish && nativeMedium !== topicMedium ? nativeMedium : topicMedium;

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
