import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getArchetypesWithChapterTopic } from "@/lib/archetypeCoverage";
import { toArchetypeGradeOrYear } from "@/lib/archetypeGradeName";
import type { Medium } from "@/lib/supabase/types";

// Batched, one call per board/grade/subject/medium scope (not per topic) --
// TopicList already fetches every topic in a subject in one query, and this
// mirrors that rather than making the sidebar fire one request per row.
// Returns "seen a generated exercise following this pattern," never
// "answered correctly" -- see 0042_student_archetype_progress.sql's own
// comment on why that distinction matters and what this app can and can't
// actually claim.
export type TopicArchetypeProgress = { chapter: string; topic: string; total: number; practiced: number };
export type ArchetypeProgressResponse = { progress: TopicArchetypeProgress[] };

export async function GET(request: Request) {
  try {
    return await handleGet(request);
  } catch (err) {
    console.error("Unexpected error in GET /api/topics/archetype-progress:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

async function handleGet(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const url = new URL(request.url);
  const boardId = url.searchParams.get("boardId");
  const gradeId = url.searchParams.get("gradeId");
  const subjectId = url.searchParams.get("subjectId");
  const mediumParam = url.searchParams.get("medium");
  if (!boardId || !gradeId || !subjectId || !mediumParam) {
    return NextResponse.json({ error: "boardId, gradeId, subjectId, and medium are required" }, { status: 400 });
  }
  const VALID_MEDIUMS: Medium[] = ["English", "Hindi", "Bengali"];
  if (!VALID_MEDIUMS.includes(mediumParam as Medium)) {
    return NextResponse.json({ error: "medium must be one of English, Hindi, Bengali" }, { status: 400 });
  }
  const medium = mediumParam as Medium;

  const [{ data: board }, { data: grade }, { data: subject }, { data: topics }, { data: seenRows }] = await Promise.all([
    supabase.from("boards").select("name").eq("id", boardId).single(),
    supabase.from("grades").select("name").eq("id", gradeId).single(),
    supabase.from("subjects").select("name").eq("id", subjectId).single(),
    supabase.from("syllabus_topics").select("chapter, topic").eq("board_id", boardId).eq("grade_id", gradeId).eq("subject_id", subjectId).eq("medium", medium),
    // RLS-scoped to this user's own rows (see 0042_student_archetype_progress.sql) --
    // no explicit user_id filter needed, the policy already enforces it,
    // same trust model student_usage_limits already uses.
    supabase
      .from("student_archetype_progress")
      .select("run_id, archetype_id")
      .eq("board_id", boardId)
      .eq("grade_id", gradeId)
      .eq("subject_id", subjectId)
      .eq("medium", medium),
  ]);

  if (!board || !grade || !subject || !topics) {
    return NextResponse.json({ progress: [] } satisfies ArchetypeProgressResponse);
  }

  // Matching archetypes to a curriculum scope needs admin-level read
  // access (archetypes/archetype_question_signatures have no student-
  // facing RLS policy -- this data is curated/internal, students only
  // ever see the derived counts this route computes from it, never the
  // rows themselves).
  const admin = createAdminClient();
  // See toArchetypeGradeOrYear's own comment -- grades.name ("Grade N")
  // never matches education_context.grade_or_year ("N") unstripped.
  const gradeOrYear = toArchetypeGradeOrYear(grade.name);
  const archetypeRows = await getArchetypesWithChapterTopic(admin, { board: board.name, grade: gradeOrYear, subject: subject.name });

  const seen = new Set(
    ((seenRows ?? []) as { run_id: string; archetype_id: string }[]).map((r) => `${r.run_id}:${r.archetype_id}`)
  );

  // syllabus_topics turns out to use TWO different granularity conventions
  // in the live catalog, confirmed directly: some subjects give `chapter`
  // the real chapter name and `topic` a within-chapter summary (e.g. CBSE
  // Grade 10 Physics: chapter "Electricity", topic "Ohm's law, resistance,
  // series & parallel circuits") -- but most of the CBSE Grade 11/12
  // catalog (exactly where archetype mining has concentrated) instead sets
  // `chapter` to the SUBJECT name or a book title for every row ("Mathematics",
  // "Flamingo", ...) and puts the real per-chapter granularity in `topic`
  // (e.g. "Matrices", "Determinants"). Archetypes' own resolvedChapter is
  // always the real chapter name (Stage 1's own curriculum classification),
  // so matching it only against t.chapter silently returned zero matches
  // for the whole second convention -- which is most of what's actually
  // been mined. Match against EITHER field instead; resolvedTopic (finer
  // than anything syllabus_topics tracks in either convention) isn't part
  // of this match at all.
  const normalize = (s: string) => s.trim().toLowerCase();
  const progress: TopicArchetypeProgress[] = topics.map((t) => {
    const matching = archetypeRows.filter(
      (a) => normalize(a.resolvedChapter) === normalize(t.chapter) || normalize(a.resolvedChapter) === normalize(t.topic)
    );
    const practiced = matching.filter((a) => seen.has(`${a.run_id}:${a.archetype_id}`)).length;
    return { chapter: t.chapter, topic: t.topic, total: matching.length, practiced };
  });

  return NextResponse.json({ progress } satisfies ArchetypeProgressResponse);
}
