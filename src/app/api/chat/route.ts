import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isStaff } from "@/lib/auth";
import { getOrchestratedReply, type ChatOrchestrationRequest } from "@/lib/orchestratorClient";
import type { ChatMessage } from "@/lib/supabase/types";

const HISTORY_LIMIT = 20;
const MAX_MESSAGE_LENGTH = 2000;

export async function POST(request: Request) {
  // Every code path below must return through NextResponse.json — this
  // top-level catch is the backstop so an unexpected throw (e.g. a missing
  // env var) never reaches the client as an empty/non-JSON body, which is
  // impossible for `fetch(...).json()` on the client to parse.
  try {
    return await handleChatRequest(request);
  } catch (err) {
    console.error("Unexpected error in /api/chat:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

async function handleChatRequest(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const subjectId = typeof body?.subjectId === "string" ? body.subjectId : "";
  const message = typeof body?.message === "string" ? body.message.trim() : "";

  if (!subjectId || !message) {
    return NextResponse.json({ error: "subjectId and message are required" }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json({ error: "Message is too long" }, { status: 400 });
  }

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();

  let subscriptionId: string | null = null;
  let orchestrationRequest: ChatOrchestrationRequest;

  if (isStaff(profile?.role)) {
    // Staff never subscribe: only requirement is that the subject exists.
    const { data: subject } = await supabase.from("subjects").select("name").eq("id", subjectId).single();
    if (!subject) {
      return NextResponse.json({ error: "Unknown subject" }, { status: 404 });
    }
    orchestrationRequest = {
      mode: "staff",
      userId: user.id,
      subjectId,
      subjectName: subject.name,
      message,
      history: [],
    };
  } else {
    const { data: subscription } = await supabase
      .from("subscriptions")
      .select("id, board_id, grade_id, medium, status")
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();

    if (!subscription) {
      return NextResponse.json({ error: "No active subscription" }, { status: 403 });
    }

    const { data: subjectLink } = await supabase
      .from("subscription_subjects")
      .select("subject_id, subjects(name)")
      .eq("subscription_id", subscription.id)
      .eq("subject_id", subjectId)
      .maybeSingle();

    if (!subjectLink) {
      return NextResponse.json(
        { error: "That subject is not part of your subscription" },
        { status: 403 }
      );
    }

    const [{ data: board }, { data: grade }, { data: topics }] = await Promise.all([
      supabase.from("boards").select("name").eq("id", subscription.board_id).single(),
      supabase.from("grades").select("name").eq("id", subscription.grade_id).single(),
      supabase
        .from("syllabus_topics")
        .select("chapter, topic")
        .eq("board_id", subscription.board_id)
        .eq("grade_id", subscription.grade_id)
        .eq("subject_id", subjectId)
        .eq("medium", subscription.medium)
        .order("sort_order"),
    ]);

    const subjectName =
      (subjectLink as unknown as { subjects: { name: string } | null }).subjects?.name ?? "the subject";

    subscriptionId = subscription.id;
    orchestrationRequest = {
      mode: "student",
      userId: user.id,
      subjectId,
      subjectName,
      boardId: subscription.board_id,
      boardName: board?.name ?? "",
      gradeId: subscription.grade_id,
      gradeName: grade?.name ?? "",
      medium: subscription.medium,
      topics: topics ?? [],
      message,
      history: [],
    };
  }

  let historyQuery = supabase
    .from("chat_messages")
    .select("role, content")
    .eq("user_id", user.id)
    .eq("subject_id", subjectId);
  historyQuery = subscriptionId
    ? historyQuery.eq("subscription_id", subscriptionId)
    : historyQuery.is("subscription_id", null);
  const { data: history } = await historyQuery.order("created_at", { ascending: false }).limit(HISTORY_LIMIT);

  orchestrationRequest.history = (history ?? [])
    .slice()
    .reverse()
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  let assistantText: string;
  try {
    ({ reply: assistantText } = await getOrchestratedReply(orchestrationRequest));
  } catch (err) {
    console.error("Orchestrator chat request failed:", err);
    return NextResponse.json(
      { error: "The tutor is temporarily unavailable. Please try again shortly." },
      { status: 502 }
    );
  }

  // Written with the service-role client: RLS deliberately allows no
  // client-side inserts on chat_messages (see migration 0002), so this is
  // the only path a conversation turn can be persisted through.
  const admin = createAdminClient();
  const { data: inserted, error: insertError } = await admin
    .from("chat_messages")
    .insert([
      {
        user_id: user.id,
        subscription_id: subscriptionId,
        subject_id: subjectId,
        role: "user",
        content: message,
      },
      {
        user_id: user.id,
        subscription_id: subscriptionId,
        subject_id: subjectId,
        role: "assistant",
        content: assistantText,
      },
    ])
    .select("*");

  if (insertError || !inserted) {
    console.error("Failed to persist chat_messages:", insertError);
    return NextResponse.json({ error: "Could not save the conversation" }, { status: 500 });
  }

  const rows = inserted as ChatMessage[];

  return NextResponse.json({
    userMessage: rows.find((m) => m.role === "user"),
    assistantMessage: rows.find((m) => m.role === "assistant"),
  });
}
