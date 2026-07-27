import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTopicSummary } from "@/lib/orchestratorClient";

// Every code path below must return through NextResponse.json -- this
// top-level catch is the backstop so an unexpected throw never reaches the
// client as an empty/non-JSON body. Same pattern as /api/chat.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await handleGetSummary(await params);
  } catch (err) {
    console.error("Unexpected error in GET /api/topics/[id]/summary:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

async function handleGetSummary({ id: topicId }: { id: string }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // syllabus_topics is readable by any authenticated user under RLS (same
  // policy the admin catalog and the syllabus panel itself rely on) -- no
  // extra entitlement check needed here beyond being signed in.
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
    supabase.from("subjects").select("name").eq("id", topicRow.subject_id).single(),
  ]);

  try {
    const { summary } = await getTopicSummary({
      userId: user.id,
      topicId,
      subjectId: topicRow.subject_id,
      subjectName: subject?.name ?? "",
      boardName: board?.name ?? "",
      gradeName: grade?.name ?? "",
      medium: topicRow.medium,
      chapter: topicRow.chapter,
      topic: topicRow.topic,
    });
    return NextResponse.json({ summary });
  } catch (err) {
    console.error("Topic summary request failed:", err);
    return NextResponse.json(
      { error: "Could not load the summary. Please try again shortly." },
      { status: 502 }
    );
  }
}
