import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isStaff } from "@/lib/auth";
import { resolveStaffPreviewScope } from "@/lib/staffPreview";
import type { Medium } from "@/lib/supabase/types";

const MAX_SUMMARY_LENGTH = 20_000;

// Every code path below must return through NextResponse.json -- this
// top-level catch is the backstop so an unexpected throw never reaches the
// client as an empty/non-JSON body. Same pattern as /api/chat.
export async function POST(request: Request) {
  try {
    return await handlePost(request);
  } catch (err) {
    console.error("Unexpected error in POST /api/chat/topic-summary:", err);
    return NextResponse.json({ error: "Could not save this to your chat history" }, { status: 500 });
  }
}

// Persists a topic-summary bubble (see chat-panel.tsx's TimelineEntry
// "topic" kind) as a chat_messages row -- called once, right after
// TopicSummaryMessage's own fetch to /api/topics/[id]/summary has already
// resolved client-side, never duplicating that LLM call itself. The
// summary text is passed in from the client rather than re-fetched here,
// since the client already has it and a second call would be a second
// spend for nothing.
//
// Returns the new row's id so the client can later PATCH
// /api/chat/[messageId]/exercises onto it as TopicPractice's own exercise
// list underneath this bubble grows (see that route's own comment).
async function handlePost(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const topicId = typeof body?.topicId === "string" ? body.topicId : "";
  const summary = typeof body?.summary === "string" ? body.summary.trim() : "";
  const preferEnglish = body?.preferEnglish === true;
  if (!topicId || !summary) {
    return NextResponse.json({ error: "topicId and summary are required" }, { status: 400 });
  }
  if (summary.length > MAX_SUMMARY_LENGTH) {
    return NextResponse.json({ error: "Summary is too long" }, { status: 400 });
  }

  const { data: topicRow } = await supabase
    .from("syllabus_topics")
    .select("subject_id")
    .eq("id", topicId)
    .maybeSingle();
  if (!topicRow) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  // Same three-way chat-thread scoping as /api/chat's own insert: a real
  // student's subscription; a staff preview of one specific board/grade/
  // medium (its own separate thread, see 0036_chat_messages_staff_preview_scope.sql);
  // or unrestricted staff mode. Re-resolved here rather than trusted from
  // the client, same reasoning as every other route that writes this table.
  let subscriptionId: string | null = null;
  let previewBoardId: string | null = null;
  let previewGradeId: string | null = null;
  let previewMedium: Medium | null = null;

  if (isStaff(profile?.role)) {
    const preview = await resolveStaffPreviewScope(supabase, topicRow.subject_id, {
      boardId: body?.previewBoardId,
      gradeId: body?.previewGradeId,
      medium: body?.previewMedium,
    });
    if (preview) {
      previewBoardId = preview.boardId;
      previewGradeId = preview.gradeId;
      previewMedium = preview.medium;
    }
  } else {
    const { data: subscription } = await supabase
      .from("subscriptions")
      .select("id")
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();
    if (!subscription) {
      return NextResponse.json(
        { error: "Please finish setting up your board, grade, and subjects first." },
        { status: 403 },
      );
    }
    subscriptionId = subscription.id;
  }

  const isPreview = Boolean(previewBoardId && previewGradeId && previewMedium);

  // Written with the service-role client -- RLS deliberately allows no
  // client-side inserts on chat_messages (see migration 0002), same
  // posture as every ordinary chat turn.
  const admin = createAdminClient();
  const { data: inserted, error } = await admin
    .from("chat_messages")
    .insert({
      user_id: user.id,
      subscription_id: subscriptionId,
      subject_id: topicRow.subject_id,
      board_id: isPreview ? previewBoardId : null,
      grade_id: isPreview ? previewGradeId : null,
      medium: isPreview ? previewMedium : null,
      role: "topic_summary",
      content: summary,
      topic_id: topicId,
      prefer_english: preferEnglish,
    })
    .select("id")
    .single();

  if (error || !inserted) {
    console.error("Failed to persist topic-summary chat_messages row:", error);
    return NextResponse.json({ error: "Could not save this to your chat history" }, { status: 500 });
  }

  return NextResponse.json({ id: inserted.id });
}
