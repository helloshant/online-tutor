import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTopicSubtopics } from "@/lib/orchestratorClient";
import { toArchetypeGradeOrYear } from "@/lib/archetypeGradeName";

// One sub-topic picker option, shown before a student drills into a
// chapter's exercises -- a real, exam-mined sub-topic (CBSE today, see
// getTopicSubtopics/the orchestrator's own /v1/topic-exercises/subtopics).
//
// This used to also merge in one entry per individual glossary/definition
// term extracted from the chapter's own content chunks (the WBBSE/ICSE
// fallback, see getTopicConcepts/chunkConcepts.ts), for a chapter with no
// real exam-mined data. Reported directly against a live example
// ("Understanding Markets"): that fallback surfaced 27 single-term picks
// (Market, Needs, Wants, Trade, Price...) -- individually accurate (each
// really is defined in the chapter), but not a useful narrowing step, just
// noise ahead of the real choice a student wants ("give me exercises for
// this chapter"). Dropped board-agnostically rather than only for this one
// chapter's subject: a chapter with no exam-mined sub-topics now always
// returns an empty list here, which the frontend already treats as "skip
// the picker, load the whole chapter's exercises directly" -- same
// fallback path a chapter with no data of any kind already took.
export type SubtopicOption = { kind: "archetype"; name: string; questionCount: number };

// Thin proxy, same "resolve topicId -> board/grade/subject names, then call
// the orchestrator" shape as /api/topics/[id]/exercises/patterns/route.ts.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await handleGet(await params);
  } catch (err) {
    console.error("Unexpected error in GET /api/topics/[id]/exercises/subtopics:", err);
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

  // Best-effort: a failure here just means an empty picker list, same
  // fallback the frontend already takes for a chapter with no exam-mined
  // sub-topics at all.
  const subtopicsResult = await getTopicSubtopics({
    boardName: board?.name ?? "",
    // See toArchetypeGradeOrYear's own comment -- grades.name ("Grade N")
    // never matches archetype education_context.grade_or_year ("N")
    // unstripped.
    gradeName: toArchetypeGradeOrYear(grade?.name ?? ""),
    subjectName: subject?.name ?? "",
    chapter: topicRow.chapter,
    topic: topicRow.topic,
  }).catch((err) => {
    console.error("Topic subtopics request failed:", err);
    return { subtopics: [] };
  });

  const subtopics: SubtopicOption[] = subtopicsResult.subtopics.map(
    (s): SubtopicOption => ({ kind: "archetype", name: s.name, questionCount: s.questionCount })
  );

  return NextResponse.json({ subtopics });
}
