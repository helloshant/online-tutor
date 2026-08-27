import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isStaff } from "@/lib/auth";
import { resolveStaffPreviewScope } from "@/lib/staffPreview";
import { resolveMonthlyTokenLimit, startOfCurrentMonthIso } from "@/lib/usageLimits";
import {
  getOrchestratedReply,
  type ChatOrchestrationRequest,
  type ImageAttachment,
  type ImageMediaType,
} from "@/lib/orchestratorClient";
import type { ChatMessage, Database, Medium } from "@/lib/supabase/types";

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

const MAX_TOPIC_LABEL_LENGTH = 200;
const MAX_TOPIC_SUMMARY_LENGTH = 4000;

// Reported: asking a follow-up right after clicking a syllabus topic (e.g.
// "What is the theme of the poem?" right after the "Autumn" topic summary
// was shown) made the tutor ask which poem, as if the summary had never
// been shown at all. Root cause: TopicSummaryMessage's bubble is a local,
// never-persisted timeline entry (see chat-panel.tsx's own comment on
// TimelineEntry) -- the `history` this route builds further below comes
// entirely from chat_messages rows in the DB, which a topic bubble was
// never written into, so the orchestrator genuinely had zero information
// about it. This is the client's side of the fix: chat-panel.tsx sends
// the topic (and its already-loaded summary text) it's currently showing,
// ONLY when that bubble is still the very last thing in the timeline --
// same "still what the student is looking at" criterion the language-
// toggle sync already uses for a topic bubble elsewhere in that file.
// Soft-validated (a malformed/oversized value is just dropped, not a 400)
// since this only ever enriches context a request would otherwise work
// fine without.
function parseTopicContext(raw: unknown): { chapter: string; topic: string; summary: string } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { chapter, topic, summary } = raw as { chapter?: unknown; topic?: unknown; summary?: unknown };
  if (
    typeof chapter !== "string" ||
    typeof topic !== "string" ||
    typeof summary !== "string" ||
    !chapter.trim() ||
    !topic.trim() ||
    !summary.trim() ||
    chapter.length > MAX_TOPIC_LABEL_LENGTH ||
    topic.length > MAX_TOPIC_LABEL_LENGTH ||
    summary.length > MAX_TOPIC_SUMMARY_LENGTH
  ) {
    return undefined;
  }
  return { chapter, topic, summary };
}

// Shared by a real student's subscription-derived scope and a staff
// member's preview-derived scope (see resolveStaffPreviewScope) -- both
// resolve to the exact same board/grade/medium/topics/contentMedium/
// responseLanguage derivation, just sourced from a different place. Kept as
// one function so the two never drift out of sync with each other.
async function buildStudentOrchestrationRequest(
  supabase: SupabaseClient<Database>,
  params: {
    userId: string;
    subjectId: string;
    subjectName: string;
    subjectCode: string;
    boardId: string;
    gradeId: string;
    medium: Medium;
    preferEnglish: boolean;
    message: string;
    image?: ImageAttachment;
  }
): Promise<ChatOrchestrationRequest> {
  const isEnglishSubject = params.subjectCode === ENGLISH_SUBJECT_CODE;

  // See the matching comments in the original single-branch version of this
  // route (still accurate): contentMedium decides what's in scope to ask
  // about (syllabus/RAG/cache), responseLanguage only decides what language
  // the reply is written in.
  const contentMedium: Medium = isEnglishSubject ? "English" : params.medium;
  const responseLanguage: Medium =
    params.preferEnglish && isEnglishSubject && params.medium !== "English" ? "English" : params.medium;

  const [{ data: board }, { data: grade }, { data: topics }] = await Promise.all([
    supabase.from("boards").select("name").eq("id", params.boardId).single(),
    supabase.from("grades").select("name").eq("id", params.gradeId).single(),
    supabase
      .from("syllabus_topics")
      .select("chapter, topic")
      .eq("board_id", params.boardId)
      .eq("grade_id", params.gradeId)
      .eq("subject_id", params.subjectId)
      .eq("medium", contentMedium)
      .order("sort_order"),
  ]);

  return {
    mode: "student",
    userId: params.userId,
    subjectId: params.subjectId,
    subjectName: params.subjectName,
    boardId: params.boardId,
    boardName: board?.name ?? "",
    gradeId: params.gradeId,
    gradeName: grade?.name ?? "",
    medium: contentMedium,
    responseLanguage,
    topics: topics ?? [],
    message: params.message,
    image: params.image,
    history: [],
  };
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
  // Set when the toggle is flipped while the *last* exchange in the chat is
  // still on screen (see chat-panel.tsx's "regenerate last reply" effect) --
  // re-answers the same question with the new language preference and
  // overwrites this existing assistant row in place, rather than inserting
  // a new pair, so the conversation doesn't grow and a reload shows the
  // same (regenerated) reply the student is currently looking at. Ownership
  // (this user, this subject/subscription, role='assistant') is verified
  // below rather than trusted from the client, same reasoning as every
  // other id a client passes into a mutating endpoint.
  const regenerateMessageId = typeof body?.regenerateMessageId === "string" ? body.regenerateMessageId : "";
  const { image, error: imageError } = parseImageField(body?.image);
  const topicContext = parseTopicContext(body?.topicContext);

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
  // Set only for a staff member actively previewing a specific
  // board/grade/medium (see resolveStaffPreviewScope) -- used below to
  // scope/persist their chat_messages rows separately per preview, instead
  // of mixing them into one thread the way unrestricted staff chat always
  // has (see 0036_chat_messages_staff_preview_scope.sql).
  let previewBoardId: string | null = null;
  let previewGradeId: string | null = null;
  let previewMedium: Medium | null = null;
  let orchestrationRequest: ChatOrchestrationRequest;

  if (isStaff(profile?.role)) {
    // Staff never subscribe: only requirement is that the subject exists.
    const { data: subject } = await supabase.from("subjects").select("name, code").eq("id", subjectId).single();
    if (!subject) {
      return NextResponse.json({ error: "Unknown subject" }, { status: 404 });
    }

    // A staff member can optionally preview a specific board/grade/medium
    // to see exactly what a student under that combination experiences --
    // resolved/validated the same way onboarding validates a real
    // student's own selection (see resolveStaffPreviewScope). Absent or
    // invalid falls through to the unrestricted "ask anything" mode staff
    // chat has always been.
    const preview = await resolveStaffPreviewScope(supabase, subjectId, {
      boardId: body?.previewBoardId,
      gradeId: body?.previewGradeId,
      medium: body?.previewMedium,
    });

    if (preview) {
      previewBoardId = preview.boardId;
      previewGradeId = preview.gradeId;
      previewMedium = preview.medium;
      orchestrationRequest = await buildStudentOrchestrationRequest(supabase, {
        userId: user.id,
        subjectId,
        subjectName: subject.name,
        subjectCode: subject.code,
        boardId: preview.boardId,
        gradeId: preview.gradeId,
        medium: preview.medium,
        preferEnglish,
        message,
        image,
      });
    } else {
      orchestrationRequest = {
        mode: "staff",
        userId: user.id,
        subjectId,
        subjectName: subject.name,
        message,
        image,
        history: [],
      };
    }
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

    subscriptionId = subscription.id;
    orchestrationRequest = await buildStudentOrchestrationRequest(supabase, {
      userId: user.id,
      subjectId,
      subjectName: subjectRow?.name ?? "the subject",
      subjectCode: subjectRow?.code ?? "",
      boardId: subscription.board_id,
      gradeId: subscription.grade_id,
      medium: subscription.medium,
      preferEnglish,
      message,
      image,
    });
  }

  // Written with the service-role client: RLS deliberately allows no
  // client-side inserts on chat_messages (see migration 0002), so this is
  // the only path a conversation turn can be persisted through. Created
  // here (rather than right before its first use, further down) because
  // the usage-quota check right below also needs it, to read a student's
  // admin-set override and call the token-usage RPC -- both service-role
  // only (see supabase/migrations/0037_student_token_usage_limits.sql).
  const admin = createAdminClient();

  // Usage-based pricing enforcement -- gated on subscriptionId, which is
  // only ever set in the real-student branch just above: staff, whether
  // unrestricted or previewing a specific board/grade, stays unmetered,
  // same "unrestricted" posture staff already gets from every other
  // syllabus/scope check in this route. Checked before the orchestrator is
  // ever called (further below), so an over-quota request never spends
  // anything on a fresh LLM call in the first place -- and before the
  // regenerate-lookup/history queries just below too, so a blocked request
  // does the least possible work.
  if (subscriptionId) {
    const { data: override } = await admin
      .from("student_usage_limits")
      .select("monthly_token_limit")
      .eq("user_id", user.id)
      .maybeSingle();

    const { unlimited, limit } = resolveMonthlyTokenLimit(override);

    if (!unlimited) {
      const { data: usedTokens, error: usageError } = await admin.rpc("monthly_llm_tokens_for_user", {
        p_user_id: user.id,
        p_since: startOfCurrentMonthIso(),
      });
      if (usageError) {
        // Fail OPEN on a metering error (e.g. a transient DB issue):
        // blocking every student's ability to ask a question because the
        // usage lookup itself failed would be a far worse outage than
        // occasionally under-enforcing a cap for one request.
        console.error("Failed to check monthly token usage, allowing the request:", usageError);
      } else if ((usedTokens ?? 0) >= limit) {
        return NextResponse.json(
          { error: "You've reached this month's AI tutoring usage limit. It resets at the start of next month." },
          { status: 429 }
        );
      }
    }
  }

  // When regenerating, the history the model should see is exactly what it
  // saw the *first* time this exchange was answered -- everything strictly
  // before it, not including the question/reply pair being redone. Looking
  // this row up now (rather than trusting a client-supplied timestamp) also
  // doubles as the ownership check: a regenerateMessageId for a message
  // that doesn't belong to this user/subject/subscription, or isn't an
  // assistant row, is rejected outright rather than silently regenerating
  // nothing or someone else's conversation.
  // Three distinct threads a chat_messages row can belong to -- applied
  // identically below wherever a query needs to land in exactly one of
  // them: a real student's subscription; a staff preview of one specific
  // board/grade/medium (kept separate from every other preview, and from
  // unrestricted mode, by 0036_chat_messages_staff_preview_scope.sql); or
  // unrestricted staff mode (today's original behavior, unchanged).
  const isPreview = Boolean(previewBoardId && previewGradeId && previewMedium);

  let regenerateCutoff: string | null = null;
  if (regenerateMessageId) {
    let targetQuery = supabase
      .from("chat_messages")
      .select("id, created_at")
      .eq("id", regenerateMessageId)
      .eq("user_id", user.id)
      .eq("subject_id", subjectId)
      .eq("role", "assistant");
    if (subscriptionId) {
      targetQuery = targetQuery.eq("subscription_id", subscriptionId);
    } else if (isPreview) {
      targetQuery = targetQuery
        .is("subscription_id", null)
        .eq("board_id", previewBoardId as string)
        .eq("grade_id", previewGradeId as string)
        .eq("medium", previewMedium as Medium);
    } else {
      targetQuery = targetQuery.is("subscription_id", null).is("board_id", null).is("grade_id", null);
    }
    const { data: target } = await targetQuery.maybeSingle();
    if (!target) {
      return NextResponse.json({ error: "That message can't be regenerated." }, { status: 404 });
    }
    regenerateCutoff = target.created_at;
  }

  let historyQuery = supabase
    .from("chat_messages")
    .select("role, content")
    .eq("user_id", user.id)
    .eq("subject_id", subjectId);
  if (subscriptionId) {
    historyQuery = historyQuery.eq("subscription_id", subscriptionId);
  } else if (isPreview) {
    historyQuery = historyQuery
      .is("subscription_id", null)
      .eq("board_id", previewBoardId as string)
      .eq("grade_id", previewGradeId as string)
      .eq("medium", previewMedium as Medium);
  } else {
    historyQuery = historyQuery.is("subscription_id", null).is("board_id", null).is("grade_id", null);
  }
  if (regenerateCutoff) historyQuery = historyQuery.lt("created_at", regenerateCutoff);
  const { data: history } = await historyQuery.order("created_at", { ascending: false }).limit(HISTORY_LIMIT);

  orchestrationRequest.history = (history ?? [])
    .slice()
    .reverse()
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  // Splices the currently-shown topic summary in as the most recent prior
  // exchange -- as if the student had just asked for it and the tutor had
  // just given it -- so a follow-up like "what is the theme of the poem?"
  // resolves against real content instead of the model having no idea what
  // "the poem" refers to (see parseTopicContext's own comment for the full
  // root cause). Appended after the real history (oldest-first, so this
  // correctly lands as the most recent thing) and only for student mode --
  // staff's unrestricted chat has no topic/syllabus concept for this to
  // attach to in the first place.
  if (topicContext && orchestrationRequest.mode === "student") {
    orchestrationRequest.history.push(
      {
        role: "user",
        content: `Please give me a summary of the topic "${topicContext.topic}" from the chapter "${topicContext.chapter}".`,
      },
      { role: "assistant", content: topicContext.summary }
    );
  }

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

  if (regenerateMessageId) {
    // Overwrite the existing assistant row in place -- the paired user
    // question is untouched (it's still the same question, just answered
    // again in a different language), and nothing new is inserted, so the
    // conversation's length/order is unaffected and a reload shows exactly
    // this regenerated reply rather than the one it replaced.
    const { data: updated, error: updateError } = await admin
      .from("chat_messages")
      .update({ content: assistantText })
      .eq("id", regenerateMessageId)
      .select("*")
      .single();

    if (updateError || !updated) {
      console.error("Failed to persist regenerated chat_messages row:", updateError);
      return NextResponse.json({ error: "Could not save the conversation" }, { status: 500 });
    }

    return NextResponse.json({ assistantMessage: updated as ChatMessage });
  }

  // Null for a real student (subscription_id already identifies their
  // board/grade/medium) and for unrestricted staff mode -- set only for a
  // staff row written while previewing a specific board/grade/medium, so
  // that preview keeps its own thread (see scoping comment above).
  const rowBoardId = isPreview ? previewBoardId : null;
  const rowGradeId = isPreview ? previewGradeId : null;
  const rowMedium = isPreview ? previewMedium : null;

  const { data: inserted, error: insertError } = await admin
    .from("chat_messages")
    .insert([
      {
        user_id: user.id,
        subscription_id: subscriptionId,
        subject_id: subjectId,
        board_id: rowBoardId,
        grade_id: rowGradeId,
        medium: rowMedium,
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
        board_id: rowBoardId,
        grade_id: rowGradeId,
        medium: rowMedium,
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
