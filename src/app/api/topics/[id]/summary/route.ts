import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTopicSummary } from "@/lib/orchestratorClient";
import type { Medium } from "@/lib/supabase/types";

// Mirrors ENGLISH_SUBJECT_CODE in /api/chat/route.ts.
const ENGLISH_SUBJECT_CODE = "ENG";

// Every code path below must return through NextResponse.json -- this
// top-level catch is the backstop so an unexpected throw never reaches the
// client as an empty/non-JSON body. Same pattern as /api/chat.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await handleGetSummary(request, await params);
  } catch (err) {
    console.error("Unexpected error in GET /api/topics/[id]/summary:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

async function handleGetSummary(request: Request, { id: topicId }: { id: string }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const preferEnglish = new URL(request.url).searchParams.get("preferEnglish") === "true";

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

  const [{ data: board }, { data: grade }, { data: subject }, { data: subscription }] = await Promise.all([
    supabase.from("boards").select("name").eq("id", topicRow.board_id).single(),
    supabase.from("grades").select("name").eq("id", topicRow.grade_id).single(),
    supabase.from("subjects").select("name, code").eq("id", topicRow.subject_id).single(),
    supabase.from("subscriptions").select("medium").eq("user_id", user.id).eq("status", "active").maybeSingle(),
  ]);

  const isEnglishSubject = subject?.code === ENGLISH_SUBJECT_CODE;
  const topicMedium = topicRow.medium as Medium;
  const nativeMedium: Medium = (subscription?.medium as Medium | undefined) ?? topicMedium;

  // See the matching comment in /api/chat/route.ts -- medium always stays
  // this topic's own real content medium (topicMedium; for the English
  // subject that's unconditionally "English" now, see dashboard-shell.tsx's
  // syllabusMediumFor -- there is no separate "sibling" English-medium
  // topic to redirect to any more, since English-subject topics only ever
  // exist in that one medium). responseLanguage independently decides what
  // language the summary/exercises text is generated/served in: it defaults
  // to the student's own native medium and only becomes the topic's own
  // medium when the toggle is switched on (or when the student's native
  // medium already IS that topic's medium, e.g. an English-medium student
  // asking about the English subject -- nothing to toggle to there).
  const responseLanguage: Medium =
    isEnglishSubject && !preferEnglish && nativeMedium !== topicMedium ? nativeMedium : topicMedium;

  try {
    const { summary } = await getTopicSummary({
      userId: user.id,
      topicId,
      subjectId: topicRow.subject_id,
      subjectName: subject?.name ?? "",
      boardName: board?.name ?? "",
      gradeName: grade?.name ?? "",
      medium: topicMedium,
      responseLanguage,
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
