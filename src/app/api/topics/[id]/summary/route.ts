import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTopicSummary } from "@/lib/orchestratorClient";
import { findSiblingTopic } from "@/lib/topicLanguagePreference";
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

  const [{ data: board }, { data: grade }, { data: subject }] = await Promise.all([
    supabase.from("boards").select("name").eq("id", topicRow.board_id).single(),
    supabase.from("grades").select("name").eq("id", topicRow.grade_id).single(),
    supabase.from("subjects").select("name, code").eq("id", topicRow.subject_id).single(),
  ]);

  const wantsEnglish =
    preferEnglish && subject?.code === ENGLISH_SUBJECT_CODE && topicRow.medium !== "English";

  // Two different ways the toggle can be honored, tried in order:
  //   1. A sibling topic (same chapter/topic text, medium = 'English')
  //      exists -- its own chapter_documents/topic_summaries/
  //      answered_questions are genuinely in English, so the full RAG ->
  //      cache -> database -> LLM pipeline runs against *that* topic's id,
  //      exactly like any ordinary native-language request. No separate
  //      responseLanguage override is needed here: medium already equals
  //      what was asked for once resolved to the sibling.
  //   2. No sibling exists -- there is nothing in English to look up, so
  //      the original topicId/medium are kept and `responseLanguage`
  //      overrides just the reply language; the orchestrator skips
  //      RAG/cache/database entirely and always generates fresh via the
  //      LLM without persisting (see /v1/topic-summary in server.ts) --
  //      there's no topic row in English to attach a cached/stored
  //      summary to.
  let effectiveTopicId = topicId;
  let effectiveMedium = topicRow.medium;
  let responseLanguage: Medium | undefined;

  if (wantsEnglish) {
    const sibling = await findSiblingTopic(supabase, topicRow, "English");
    if (sibling) {
      effectiveTopicId = sibling.id;
      effectiveMedium = "English";
    } else {
      responseLanguage = "English";
    }
  }

  try {
    const { summary } = await getTopicSummary({
      userId: user.id,
      topicId: effectiveTopicId,
      subjectId: topicRow.subject_id,
      subjectName: subject?.name ?? "",
      boardName: board?.name ?? "",
      gradeName: grade?.name ?? "",
      medium: effectiveMedium,
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
