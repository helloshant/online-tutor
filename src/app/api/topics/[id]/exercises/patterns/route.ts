import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTopicPatterns } from "@/lib/orchestratorClient";
import { toArchetypeGradeOrYear } from "@/lib/archetypeGradeName";

// Lists the curated, real exam patterns mined for a topic -- powers the
// on-demand "practice a specific pattern" picker under Relevant Exercises
// (Tier C, see topic-summary-message.tsx). A thin proxy: this route's own
// job is resolving topicId -> board/grade/subject NAMES the orchestrator's
// archetype lookup matches on (see /api/topics/[id]/exercises/route.ts,
// which resolves the same names for the same reason), nothing else.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await handleGet(await params);
  } catch (err) {
    console.error("Unexpected error in GET /api/topics/[id]/exercises/patterns:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

async function handleGet({ id: topicId }: { id: string }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: topicRow } = await supabase
    .from("syllabus_topics")
    .select("board_id, grade_id, subject_id, chapter, topic")
    .eq("id", topicId)
    .maybeSingle();

  if (!topicRow) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  const [{ data: board }, { data: grade }, { data: subject }] = await Promise.all([
    supabase.from("boards").select("name").eq("id", topicRow.board_id).single(),
    supabase.from("grades").select("name").eq("id", topicRow.grade_id).single(),
    supabase.from("subjects").select("name").eq("id", topicRow.subject_id).single(),
  ]);

  try {
    const { patterns } = await getTopicPatterns({
      boardName: board?.name ?? "",
      // See toArchetypeGradeOrYear's own comment -- grades.name ("Grade
      // N") never matches archetype education_context.grade_or_year ("N")
      // unstripped.
      gradeName: toArchetypeGradeOrYear(grade?.name ?? ""),
      subjectName: subject?.name ?? "",
      chapter: topicRow.chapter,
      topic: topicRow.topic,
    });
    return NextResponse.json({ patterns });
  } catch (err) {
    console.error("Topic patterns request failed:", err);
    // Best-effort, same posture as the archetype-progress badges -- a
    // lookup failure just means the picker doesn't render, never a
    // broken topic/exercises view.
    return NextResponse.json({ patterns: [] });
  }
}
