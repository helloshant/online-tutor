import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateConceptExercises } from "@/lib/orchestratorClient";
import { toArchetypeGradeOrYear } from "@/lib/archetypeGradeName";
import { resolveResponseLanguage } from "@/lib/studentScope";
import type { Medium } from "@/lib/supabase/types";

// On-demand generation scoped to ONE concept a student picked from the
// sub-topic pill row (see /api/topics/[id]/exercises/subtopics and
// topic-summary-message.tsx) -- the WBBSE/ICSE sibling of
// /api/topics/[id]/exercises?subTopic=... for chapters with real archetype
// mining. Same "resolve topicId -> board/grade/subject, then call the
// orchestrator" shape as /api/topics/[id]/exercises/route.ts.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await handleGet(request, await params);
  } catch (err) {
    console.error("Unexpected error in GET /api/topics/[id]/exercises/generate-for-concept:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

async function handleGet(request: Request, { id: topicId }: { id: string }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const url = new URL(request.url);
  const preferEnglish = url.searchParams.get("preferEnglish") === "true";
  const conceptId = url.searchParams.get("conceptId");
  if (!conceptId) {
    return NextResponse.json({ error: "conceptId is required" }, { status: 400 });
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

  const topicMedium = topicRow.medium as Medium;
  const nativeMedium: Medium = (subscription?.medium as Medium | undefined) ?? topicMedium;
  const responseLanguage: Medium = resolveResponseLanguage(subject?.code ?? "", nativeMedium, preferEnglish);

  try {
    const { exercises } = await generateConceptExercises({
      userId: user.id,
      topicId,
      boardId: topicRow.board_id,
      gradeId: topicRow.grade_id,
      subjectId: topicRow.subject_id,
      subjectName: subject?.name ?? "",
      boardName: board?.name ?? "",
      gradeName: toArchetypeGradeOrYear(grade?.name ?? ""),
      medium: topicMedium,
      responseLanguage,
      chapter: topicRow.chapter,
      topic: topicRow.topic,
      conceptId,
    });
    return NextResponse.json({ exercises });
  } catch (err) {
    console.error("Concept exercises request failed:", err);
    return NextResponse.json({ error: "Could not load exercises. Please try again shortly." }, { status: 502 });
  }
}
