import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getArchetypesWithChapterTopic, UNKNOWN_TOPIC, type ArchetypeWithChapterTopic } from "@/lib/archetypeCoverage";
import { toArchetypeGradeOrYear } from "@/lib/archetypeGradeName";
import type { Medium, SyllabusTopic } from "@/lib/supabase/types";

// Powers the student-facing "which years was this topic actually asked in"
// browser (ExamYearTrends) -- same board/grade/subject/medium scope as
// /api/topics/archetype-progress, and deliberately built the same way (this
// app matching syllabus_topics against getArchetypesWithChapterTopic
// directly, not a call out to the orchestrator's own findArchetypesForTopic)
// since that's a per-topic exercise-grounding lookup, a different job from
// this one: "list every topic in the subject with its own year coverage,"
// batched once per subject the same way TopicList's own progress badges are.
//
// Returns each topic's FULL syllabus_topics row (not just id/chapter/topic)
// so the client can hand it straight to the same onSelectTopic(topic:
// SyllabusTopic) callback TopicList already uses -- clicking a topic here
// drops into the exact same chat-summary-plus-pattern-picker flow, rather
// than this page needing its own parallel practice UI.
// One archetype's own resolvedTopic (see archetypeCoverage.ts's own
// comment: the most common curriculum.topic among that ONE archetype's
// supporting questions) -- deliberately NOT the raw per-question
// curriculum.topic, which is far noisier: confirmed directly against real
// data, a single syllabus chapter's own mined questions carry topic
// strings like "Drugs and Substance Abuse", "Drug and Alcohol Abuse",
// "Drugs and Their Effects", and "Drug Abuse and its Effects" for what's
// really the same underlying idea (curriculum.topic was deliberately never
// reconciled the way curriculum.chapter is -- see curriculumReconciliation.ts's
// own top comment on why that pair-level reconciliation doesn't work).
// resolvedTopic is already one step cleaner since Stage 2's own clustering
// grouped the underlying questions into one archetype first, but it can
// still show near-duplicate phrasing ACROSS different archetypes under the
// same chapter -- shown as-is here rather than attempting a fuzzy merge
// with no more grounding than free-text similarity, the same class of
// unreliable judgment this session's own off-scope-content-scan work
// found repeatedly not safe to trust for anything automatic.
export type SubTopicYearCoverage = { topic: string; years: number[] };
export type TopicYearCoverage = { topic: SyllabusTopic; years: number[]; subTopics: SubTopicYearCoverage[] };
export type YearCoverageResponse = { years: number[]; topics: TopicYearCoverage[] };

// See its own use below -- coerces a possibly-string year to a real
// number, or null if it isn't one.
function toYear(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) ? n : null;
}

export async function GET(request: Request) {
  try {
    return await handleGet(request);
  } catch (err) {
    console.error("Unexpected error in GET /api/topics/year-coverage:", err);
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

  const [{ data: board }, { data: grade }, { data: subject }, { data: topics }] = await Promise.all([
    supabase.from("boards").select("name").eq("id", boardId).single(),
    supabase.from("grades").select("name").eq("id", gradeId).single(),
    supabase.from("subjects").select("name").eq("id", subjectId).single(),
    supabase
      .from("syllabus_topics")
      .select("*")
      .eq("board_id", boardId)
      .eq("grade_id", gradeId)
      .eq("subject_id", subjectId)
      .eq("medium", medium),
  ]);

  if (!board || !grade || !subject || !topics) {
    return NextResponse.json({ years: [], topics: [] } satisfies YearCoverageResponse);
  }

  // Matching archetypes to a curriculum scope needs admin-level read
  // access, same reasoning as archetype-progress's own comment -- this
  // data is curated/internal, a student only ever sees the derived
  // chapter/topic/year rows this route computes from it.
  const admin = createAdminClient();
  const gradeOrYear = toArchetypeGradeOrYear(grade.name);
  const archetypeRows = await getArchetypesWithChapterTopic(admin, { board: board.name, grade: gradeOrYear, subject: subject.name });

  // toYear guards against a real production data-quality issue: a model
  // occasionally emitted a year as a numeric STRING ("2025") instead of a
  // number, inconsistently within the same archetype's own years_observed
  // array -- an unguarded `new Set` here treats 2025 and "2025" as
  // different values (JS !== on mixed types), which showed the same year
  // twice in a pill row. See the archetype-miner service's own
  // textCoercion.ts for the source-side fix; this guards the read side
  // too since the data can't be trusted to always be clean numbers.
  function distinctYears(rows: ArchetypeWithChapterTopic[]): number[] {
    return Array.from(new Set(rows.flatMap((a) => (a.archetype.stats?.years_observed ?? []).map(toYear)).filter((y): y is number => y !== null))).sort(
      (a, b) => a - b
    );
  }

  // Same EITHER-field match as archetype-progress -- see that route's own
  // comment on why syllabus_topics' two different chapter/topic
  // granularity conventions both need checking, not just t.chapter.
  const normalize = (s: string) => s.trim().toLowerCase();
  const allYears = new Set<number>();
  const topicRows: TopicYearCoverage[] = (topics as SyllabusTopic[]).map((t) => {
    const matching = archetypeRows.filter(
      (a) => normalize(a.resolvedChapter) === normalize(t.chapter) || normalize(a.resolvedChapter) === normalize(t.topic)
    );
    const years = distinctYears(matching);
    for (const y of years) allYears.add(y);

    // See SubTopicYearCoverage's own comment on what these are (each
    // MATCHING archetype's own resolvedTopic, not raw per-question
    // curriculum.topic) and why they're shown as-is. Grouped by exact
    // string -- two archetypes that happen to share the same resolvedTopic
    // combine into one row with their years unioned; UNKNOWN_TOPIC (no
    // supporting question had a usable curriculum.topic at all) is
    // dropped, same as an unresolved chapter never gets its own row above.
    const byResolvedTopic = new Map<string, ArchetypeWithChapterTopic[]>();
    for (const a of matching) {
      if (a.resolvedTopic === UNKNOWN_TOPIC) continue;
      const group = byResolvedTopic.get(a.resolvedTopic);
      if (group) group.push(a);
      else byResolvedTopic.set(a.resolvedTopic, [a]);
    }
    const subTopics: SubTopicYearCoverage[] = Array.from(byResolvedTopic.entries())
      .map(([topic, rows]) => ({ topic, years: distinctYears(rows) }))
      // Most-covered first -- the same "worth a student's attention"
      // ordering the chapter list's own "every year" badge already
      // signals, just applied one level down.
      .sort((a, b) => b.years.length - a.years.length || a.topic.localeCompare(b.topic));

    return { topic: t, years, subTopics };
  });

  return NextResponse.json({
    years: Array.from(allYears).sort((a, b) => a - b),
    // Only topics with at least one real year of mined data -- a topic
    // with nothing mined for it yet has nothing to show on a page whose
    // whole point is "which years was this actually asked," so it's
    // omitted the same way archetype-progress's own badges omit a
    // total:0 topic rather than showing an empty "0 years" row.
    topics: topicRows.filter((t) => t.years.length > 0),
  } satisfies YearCoverageResponse);
}
