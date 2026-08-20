import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isStaff } from "@/lib/auth";
import {
  getOrchestratedReply,
  type ChatOrchestrationRequest,
  type ImageAttachment,
  type ImageMediaType,
} from "@/lib/orchestratorClient";
import type { ChatMessage, Medium } from "@/lib/supabase/types";

// The one subject where "respond in the student's native medium" isn't
// always what the student wants -- English is a language-learning subject
// itself, so a non-English-medium student may deliberately want tutor
// replies in English for immersion, not just their native medium. Gated to
// this one subject code (see supabase/migrations/0003_seed_catalog.sql)
// rather than a generic per-subject toggle, since every other subject's
// content assumes explanations happen in the student's own language.
const ENGLISH_SUBJECT_CODE = "ENG";

const HISTORY_LIMIT = 20;
const MAX_MESSAGE_LENGTH = 2000;

// Mirrors the orchestrator's own caps (services/orchestrator/src/server.ts)
// so an oversized/unsupported image is rejected here, before it's even sent
// over the wire.
const ALLOWED_IMAGE_TYPES = new Set<ImageMediaType>(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_BASE64_LENGTH = 6_000_000;

// Placeholder stored in chat_messages.content (NOT NULL) when a message is
// image-only -- the image itself is never persisted (see route body), so
// this keeps history legible without claiming to store the image.
const IMAGE_ONLY_PLACEHOLDER = "[Image]";

function parseImageField(raw: unknown): { image?: ImageAttachment; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object") return { error: "image must be an object" };

  const { mediaType, base64 } = raw as { mediaType?: unknown; base64?: unknown };
  if (typeof mediaType !== "string" || !ALLOWED_IMAGE_TYPES.has(mediaType as ImageMediaType)) {
    return { error: "image.mediaType must be one of image/jpeg, image/png, image/gif, image/webp" };
  }
  if (typeof base64 !== "string" || !base64) {
    return { error: "image.base64 is required" };
  }
  if (base64.length > MAX_IMAGE_BASE64_LENGTH) {
    return { error: "image is too large" };
  }
  return { image: { mediaType: mediaType as ImageMediaType, base64 } };
}

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
  // Only ever widens language, never narrows access -- ignored below unless
  // the subject is actually English and the student's medium isn't already
  // English, so a client sending this for any other subject just has no
  // effect rather than needing its own error path.
  const preferEnglish = body?.preferEnglish === true;
  const { image, error: imageError } = parseImageField(body?.image);

  if (!subjectId) {
    return NextResponse.json({ error: "subjectId is required" }, { status: 400 });
  }
  if (imageError) {
    return NextResponse.json({ error: imageError }, { status: 400 });
  }
  // A screenshot/photo carries its own question -- an empty typed message is
  // only invalid when there's nothing else attached.
  if (!message && !image) {
    return NextResponse.json({ error: "message or image is required" }, { status: 400 });
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
      image,
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
      .select("subject_id, subjects(name, code)")
      .eq("subscription_id", subscription.id)
      .eq("subject_id", subjectId)
      .maybeSingle();

    if (!subjectLink) {
      return NextResponse.json(
        { error: "That subject is not part of your subscription" },
        { status: 403 }
      );
    }

    const subjectRow = (subjectLink as unknown as { subjects: { name: string; code: string } | null }).subjects;
    const subjectName = subjectRow?.name ?? "the subject";
    // Only English-subject chat offers this toggle at all -- every other
    // subject's syllabus/chapter content only ever exists in the student's
    // own medium, so there'd be nothing for "English" to switch to.
    const effectiveMedium: Medium =
      preferEnglish && subjectRow?.code === ENGLISH_SUBJECT_CODE && subscription.medium !== "English"
        ? "English"
        : subscription.medium;

    const [{ data: board }, { data: grade }, { data: topics }] = await Promise.all([
      supabase.from("boards").select("name").eq("id", subscription.board_id).single(),
      supabase.from("grades").select("name").eq("id", subscription.grade_id).single(),
      supabase
        .from("syllabus_topics")
        .select("chapter, topic")
        .eq("board_id", subscription.board_id)
        .eq("grade_id", subscription.grade_id)
        .eq("subject_id", subjectId)
        .eq("medium", effectiveMedium)
        .order("sort_order"),
    ]);

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
      medium: effectiveMedium,
      topics: topics ?? [],
      message,
      image,
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
        // The image itself is never persisted (not written to storage, only
        // passed through to the LLM for this one exchange) -- content is
        // NOT NULL, so an image-only message needs a placeholder to keep
        // history legible after a reload, when the image is already gone.
        content: message || IMAGE_ONLY_PLACEHOLDER,
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
