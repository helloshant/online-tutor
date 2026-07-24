import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { CHAT_MODEL, getAnthropicClient } from "@/lib/anthropic";
import { buildTutorSystemPrompt } from "@/lib/tutorPrompt";
import type { ChatMessage } from "@/lib/supabase/types";

const HISTORY_LIMIT = 20;
const MAX_TOKENS = 1536;
const MAX_MESSAGE_LENGTH = 2000;

export async function POST(request: Request) {
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

  const [{ data: board }, { data: grade }, { data: topics }, { data: history }] = await Promise.all([
    supabase.from("boards").select("name").eq("id", subscription.board_id).single(),
    supabase.from("grades").select("name").eq("id", subscription.grade_id).single(),
    supabase
      .from("syllabus_topics")
      .select("chapter, topic")
      .eq("board_id", subscription.board_id)
      .eq("grade_id", subscription.grade_id)
      .eq("subject_id", subjectId)
      .order("sort_order"),
    supabase
      .from("chat_messages")
      .select("role, content")
      .eq("subscription_id", subscription.id)
      .eq("subject_id", subjectId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT),
  ]);

  const subjectName =
    (subjectLink as unknown as { subjects: { name: string } | null }).subjects?.name ?? "the subject";

  const systemPrompt = buildTutorSystemPrompt({
    subjectName,
    boardName: board?.name ?? "",
    gradeName: grade?.name ?? "",
    medium: subscription.medium,
    topics: topics ?? [],
  });

  const orderedHistory = (history ?? []).slice().reverse();

  let assistantText: string;
  try {
    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [
        ...orderedHistory.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        { role: "user" as const, content: message },
      ],
    });
    const textBlock = response.content.find((block) => block.type === "text");
    assistantText =
      textBlock && textBlock.type === "text"
        ? textBlock.text
        : "Sorry, I couldn't come up with an answer. Please try rephrasing your question.";
  } catch {
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
        subscription_id: subscription.id,
        subject_id: subjectId,
        role: "user",
        content: message,
      },
      {
        user_id: user.id,
        subscription_id: subscription.id,
        subject_id: subjectId,
        role: "assistant",
        content: assistantText,
      },
    ])
    .select("*");

  if (insertError || !inserted) {
    return NextResponse.json({ error: "Could not save the conversation" }, { status: 500 });
  }

  const rows = inserted as ChatMessage[];

  return NextResponse.json({
    userMessage: rows.find((m) => m.role === "user"),
    assistantMessage: rows.find((m) => m.role === "assistant"),
  });
}
