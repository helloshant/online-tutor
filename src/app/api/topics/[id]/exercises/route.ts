import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTopicExercises } from "@/lib/orchestratorClient";
import { resolveTopicForLanguagePreference } from "@/lib/topicLanguagePreference";

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

  // See resolveTopicForLanguagePreference (same helper /api/topics/[id]/
  // summary uses) -- an exercise search is tagged by topic_id the same way
  // a summary is keyed by it, so "English" here means resolving to the
  // sibling English-medium topic, not just relabeling this one.
  const preferEnglish = new URL(request.url).searchParams.get("preferEnglish") === "true";

  const { data: topicRow } = await supabase
    .from("syllabus_topics")
    .select("board_id, grade_id, subject_id, medium, chapter, topic")
    .eq("id", topicId)
    .maybeSingle();

  if (!topicRow) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  const [{ data: board }, { data: grade }, { data: subject }] = await Promise.all([
    supabase.from("boards").select("name").eq("id", topicRow.board_id).single(),
    supabase.from("grades").select("name").eq("id", topicRow.grade_id).single(),
    supabase.from("subjects").select("name, code").eq("id", topicRow.subject_id).single(),
  ]);

  const { topicId: effectiveTopicId, medium: effectiveMedium } = await resolveTopicForLanguagePreference(
    supabase,
    topicId,
    topicRow,
    subject?.code ?? "",
    preferEnglish
  );

  try {
    const { exercises } = await getTopicExercises({
      userId: user.id,
      topicId: effectiveTopicId,
      boardId: topicRow.board_id,
      gradeId: topicRow.grade_id,
      subjectId: topicRow.subject_id,
      subjectName: subject?.name ?? "",
      boardName: board?.name ?? "",
      gradeName: grade?.name ?? "",
      medium: effectiveMedium,
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
