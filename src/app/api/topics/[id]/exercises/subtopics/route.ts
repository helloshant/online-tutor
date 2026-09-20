import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTopicConcepts, getTopicSubtopics } from "@/lib/orchestratorClient";
import { toArchetypeGradeOrYear } from "@/lib/archetypeGradeName";

// One merged sub-topic picker option, shown before a student drills into a
// chapter's exercises -- either a real, exam-mined sub-topic (CBSE today,
// see getTopicSubtopics/the orchestrator's own /v1/topic-exercises/subtopics)
// or one of the chapter's own content-chunk concepts (the WBBSE/ICSE
// fallback, see getTopicConcepts). These are two genuinely separate data
// sources -- CBSE has real exam-mining coverage, WBBSE/ICSE currently have
// none at all -- merged here into one flat list so the frontend never has
// to know which source a chapter happened to have.
export type SubtopicOption =
  | { kind: "archetype"; name: string; questionCount: number }
  | { kind: "concept"; id: string; term: string };

// Thin merge proxy, same "resolve topicId -> board/grade/subject names,
// then call the orchestrator" shape as
// /api/topics/[id]/exercises/patterns/route.ts -- this route's own job is
// fanning out to both of the orchestrator's sub-topic sources and combining
// them, nothing else.
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

  const [{ data: board }, { data: grade }, { data: subject }, conceptsResult] = await Promise.all([
    supabase.from("boards").select("name").eq("id", topicRow.board_id).single(),
    supabase.from("grades").select("name").eq("id", topicRow.grade_id).single(),
    supabase.from("subjects").select("name").eq("id", topicRow.subject_id).single(),
    // Doesn't depend on the board/grade/subject names at all (a plain
    // topic_id chunk lookup) -- kicked off alongside them rather than
    // after, for max parallelism. Best-effort: a failure here just means
    // this source contributes nothing, same posture as the flat pattern
    // picker's own lookup failure handling below.
    getTopicConcepts(topicId).catch((err) => {
      console.error("Topic concepts request failed:", err);
      return { concepts: [] };
    }),
  ]);

  // Best-effort, same reasoning as conceptsResult above -- a failure on
  // this source alone shouldn't hide whatever the other source found.
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

  // Archetype-sourced entries first (real exam evidence), concept-sourced
  // ones after. A chapter with neither returns an empty array here, which
  // the frontend treats as "skip the picker, load today's flat batch
  // directly" -- see topic-summary-message.tsx.
  const subtopics: SubtopicOption[] = [
    ...subtopicsResult.subtopics.map(
      (s): SubtopicOption => ({ kind: "archetype", name: s.name, questionCount: s.questionCount })
    ),
    ...conceptsResult.concepts.map((c): SubtopicOption => ({ kind: "concept", id: c.id, term: c.term })),
  ];

  return NextResponse.json({ subtopics });
}
