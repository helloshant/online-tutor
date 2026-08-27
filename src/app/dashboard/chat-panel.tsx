"use client";

import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { CitationText } from "@/components/citation-text";
import { WorkedSteps } from "@/components/worked-steps";
import { LoadingIndicator } from "@/components/loading-indicator";
import { FeedbackButtons } from "@/components/feedback-buttons";
import { TopicSummaryMessage } from "./topic-summary-message";
import { buildRevealUnits, buildRevealedText, totalRevealWeight } from "@/lib/messageReveal";
import type { ChatMessage, Medium, SyllabusTopic } from "@/lib/supabase/types";

// Renders an assistant message's content, optionally animating it in
// word-by-word (see lib/messageReveal.ts) instead of dropping the whole
// reply in at once. `animate` is only ever true for a reply that just
// arrived this session (see performSend/regenerateLastReply below) --
// chat history loaded on mount always renders fully immediately, same as
// before this existed.
//
// `content` is expected to stay fixed for the lifetime of a given mounted
// instance -- see the `key` passed at the call site below for how a
// regenerated (translated) reply, which reuses the same message id, still
// gets a fresh instance rather than trying to re-animate over live state.
// Wrapped in memo() for the same reason MessageBubble below is: without
// it, every re-render of ChatPanel (e.g. a keystroke in the message
// input, which touches state that lives well above this in the tree)
// re-renders this too, and this is genuinely expensive to re-render --
// WorkedSteps re-parses the whole markdown tree and, via MathText,
// re-typesets every KaTeX equation in it from scratch (see math-text.tsx:
// katex.renderToString per match, not cached). memo's default shallow
// prop comparison skips all of that whenever content/animate/onProgress
// haven't actually changed, which for an already-settled reply is every
// single time a keystroke elsewhere causes ChatPanel to re-render.
const AssistantMessageContent = memo(function AssistantMessageContent({
  content,
  animate,
  onProgress,
}: {
  content: string;
  animate: boolean;
  onProgress?: () => void;
}) {
  const units = useMemo(() => buildRevealUnits(content), [content]);
  const totalWeight = useMemo(() => totalRevealWeight(units), [units]);
  const [revealedWeight, setRevealedWeight] = useState(() => (animate ? 0 : totalWeight));

  // Boxed the same way TopicSummaryMessage's onSummaryLoadedRef is --
  // fires every tick of the interval below, so it always needs the LATEST
  // onProgress the parent passed without being a dependency that would
  // tear down and restart the interval itself.
  const onProgressRef = useRef(onProgress);
  useEffect(() => {
    onProgressRef.current = onProgress;
  });

  useEffect(() => {
    if (!animate || totalWeight === 0) return;
    // Paced to take roughly the same ~2s to fully reveal regardless of
    // reply length (perTick scales up for a longer reply) rather than
    // taking proportionally longer the more the model wrote -- a short
    // answer still flows in quickly, a long worked solution doesn't drag.
    const TICK_MS = 28;
    const TARGET_TICKS = 70;
    const perTick = Math.max(1, Math.round(totalWeight / TARGET_TICKS));
    const id = setInterval(() => {
      // Marked low-priority: re-rendering the revealed slice re-typesets
      // every KaTeX equation and re-parses the whole markdown tree in it,
      // which is real work -- at 70-ish ticks over ~2s, doing that as an
      // ordinary (synchronous-priority) update was blocking the input box
      // from echoing keystrokes typed while a reply was still revealing,
      // since React had no reason to prefer the keystroke over the next
      // tick. startTransition tells React this update can be interrupted
      // by/deferred behind anything more urgent -- a keystroke's own state
      // update -- so typing stays responsive even mid-reveal; the reveal
      // itself just continues a beat later, imperceptibly.
      startTransition(() => {
        setRevealedWeight((prev) => {
          const next = Math.min(totalWeight, prev + perTick);
          if (next >= totalWeight) clearInterval(id);
          return next;
        });
      });
      onProgressRef.current?.();
    }, TICK_MS);
    return () => clearInterval(id);
    // onProgress is deliberately read via the ref above, not listed here --
    // it changes identity on every parent render, and this effect must NOT
    // restart on that (it would reset setInterval but not revealedWeight,
    // just losing the natural cadence, not real progress -- still avoided).
  }, [animate, totalWeight]);

  const display = useMemo(() => buildRevealedText(units, revealedWeight), [units, revealedWeight]);
  return <WorkedSteps text={display} />;
});

interface SubjectSummary {
  id: string;
  name: string;
  code: string;
}

// A chat message loaded from/saved to chat_messages, or a topic-summary
// entry dropped in locally when a syllabus topic is clicked (see
// dashboard-shell.tsx's topicClick prop below) -- never persisted, just
// slotted into the same visual timeline so a student can ask a follow-up
// about it without leaving the conversation.
//
// previewImageUrl is client-only too: the image itself is never persisted
// (see chat/route.ts), so this only keeps a just-sent screenshot visible in
// the timeline for the rest of the browser session -- it's lost on reload,
// same as the image on the server side.
// preferEnglish on a topic entry is that *bubble's own* snapshot of the
// language toggle, not a live read of it -- see the "sync last topic entry"
// effect below for why: only the most-recently-shown topic bubble tracks
// further toggle flips, everything earlier in a lengthy conversation stays
// frozen at whatever it was last displaying, so flipping the switch never
// re-fetches every topic summary ever opened in this conversation at once.
// revealOnMount is set only on an assistant message entry constructed
// right when its reply arrives (performSend, regenerateLastReply) -- never
// on chat history loaded from Supabase on mount, and never mutated
// afterward, so it's a stable, one-time flag for "animate this one in"
// rather than something recomputed from render state (which would risk
// flipping mid-animation and freezing it, since AssistantMessageContent
// keys its interval effect on this value -- see its own comment).
type TimelineEntry =
  | { kind: "message"; message: ChatMessage; previewImageUrl?: string; revealOnMount?: boolean }
  | { kind: "topic"; entryId: string; topic: SyllabusTopic; preferEnglish: boolean };

// Mirrors ENGLISH_SUBJECT_CODE in src/app/api/chat/route.ts, which is the
// actual enforcement point -- this copy only decides whether to render the
// toggle at all, never grants anything on its own.
const ENGLISH_SUBJECT_CODE = "ENG";

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
// Mirrors the server-side cap (~4.3MB decoded) so an oversized file is
// rejected client-side with an immediate message instead of a round trip.
const MAX_IMAGE_BASE64_LENGTH = 6_000_000;

type SelectedImage = { mediaType: string; base64: string; dataUrl: string };

function readImageFile(file: File): Promise<SelectedImage> {
  return new Promise((resolve, reject) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      reject(new Error("Please attach a JPEG, PNG, GIF, or WebP image."));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that image. Please try again."));
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      if (base64.length > MAX_IMAGE_BASE64_LENGTH) {
        reject(new Error("That image is too large. Please attach something under ~4MB."));
        return;
      }
      resolve({ mediaType: file.type, base64, dataUrl });
    };
    reader.readAsDataURL(file);
  });
}

// One "message"-kind timeline row (as opposed to a "topic"-kind row, still
// rendered inline in ChatPanel below since TopicSummaryMessage already
// manages its own async state and doesn't carry this same re-render cost).
// Pulled out and wrapped in memo() for the same reason as
// AssistantMessageContent above: without it, typing a single character
// into the message input re-renders ChatPanel, which re-renders every row
// in the whole timeline -- including every already-settled reply's full
// markdown/diagram/KaTeX tree -- for no reason at all, since none of that
// depends on the input's value. `entry` stays referentially the same
// object across a ChatPanel re-render unless it's the one actually being
// added/replaced (see performSend/regenerateLastReply), so memo's default
// shallow prop comparison correctly skips re-rendering every other row.
const MessageBubble = memo(function MessageBubble({
  entry,
  subjectId,
  isRegenerating,
  onRevealProgress,
}: {
  entry: Extract<TimelineEntry, { kind: "message" }>;
  subjectId: string;
  isRegenerating: boolean;
  onRevealProgress: () => void;
}) {
  const { message, previewImageUrl } = entry;
  return (
    <div className={`flex flex-col ${message.role === "user" ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ${
          message.role === "user" ? "bg-brand text-white" : "border border-border bg-surface text-foreground"
        }`}
      >
        {previewImageUrl && (
          // A transient client-side data URL, never persisted, so
          // next/image's remote-loader/optimization machinery doesn't apply.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewImageUrl} alt="Attached" className="mb-2 max-h-48 rounded-lg border border-white/20" />
        )}
        {isRegenerating ? (
          <span className="text-foreground/40">
            <LoadingIndicator label="Translating…" />
          </span>
        ) : (
          message.content !== "[Image]" &&
          // Only the assistant is ever prompted to produce [STEP: ...]
          // markers (buildTutorSystemPrompt's rule 5) -- a student's own
          // message goes straight through CitationText, same as before, so
          // nothing they type could coincidentally be misread as step
          // structure.
          (message.role === "assistant" ? (
            <AssistantMessageContent
              // Re-keyed on content length, not just the message id:
              // regenerateLastReply overwrites `message` in place (same
              // id, new content) when the language toggle re-answers the
              // last reply, and that new text deserves its own fresh
              // reveal rather than reusing a mounted instance already
              // sitting at its old, now-stale revealedWeight/totalWeight.
              key={`${message.id}:${message.content.length}`}
              content={message.content}
              animate={!!entry.revealOnMount}
              onProgress={onRevealProgress}
            />
          ) : (
            <CitationText text={message.content} />
          ))
        )}
      </div>
      {/* Only a real, settled assistant reply -- not the optimistic user
          bubble, and not while this exact reply is still being re-answered
          in another language (nothing stable to attach feedback to
          mid-regeneration). */}
      {message.role === "assistant" && !isRegenerating && !message.id.startsWith("optimistic-") && (
        <FeedbackButtons kind="chat_message" targetId={message.id} subjectId={subjectId} contentSnapshot={message.content} />
      )}
    </div>
  );
});

export function ChatPanel({
  subscriptionId,
  subject,
  boardId,
  gradeId,
  medium,
  isStaffUser,
  topicClick,
  practiceQuestionClick,
}: {
  subscriptionId: string | null;
  subject: SubjectSummary;
  // Set for a real student always, and for staff only while previewing a
  // specific board/grade -- null for staff in unrestricted mode. Sent back
  // to /api/chat as previewBoardId/previewGradeId so a staff request lands
  // in that preview's own chat thread (see 0036_chat_messages_staff_preview_scope.sql)
  // rather than staff's shared unrestricted-mode thread; harmless/ignored
  // for a real student, whose scope is always subscription-derived anyway.
  boardId: string | null;
  gradeId: string | null;
  medium: Medium | null;
  isStaffUser: boolean;
  topicClick: { clickId: string; topic: SyllabusTopic } | null;
  practiceQuestionClick: { clickId: string; question: string; answer: string } | null;
}) {
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState<SelectedImage | null>(null);
  // Id of the assistant message currently being regenerated in a different
  // language (see the toggle-driven effect below) -- distinct from
  // `sending`, which is only for a brand-new message the student is
  // actively typing/submitting.
  const [regeneratingMessageId, setRegeneratingMessageId] = useState<string | null>(null);
  // Only English (the subject) offers this -- every other subject's
  // content only exists in the student's own medium, so there'd be nothing
  // for "English" to switch to. This component remounts per subject (see
  // dashboard-shell.tsx's `key={selectedSubject.id}` on ChatPanel), so the
  // toggle naturally resets to "native" whenever the student switches away
  // and back, rather than needing an explicit reset effect here.
  const showLanguageToggle = medium !== null && medium !== "English" && subject.code === ENGLISH_SUBJECT_CODE;
  const [preferEnglish, setPreferEnglish] = useState(false);
  // What the toggle actually means right now -- false whenever it isn't even
  // shown, same guard the server independently re-checks (see /api/chat and
  // /api/topics/[id]/summary), so this is never trusted on its own for
  // anything but deciding what to render/send.
  const effectivePreferEnglish = showLanguageToggle && preferEnglish;
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastClickIdRef = useRef<string | null>(null);
  const lastPracticeClickIdRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user || cancelled) return;

      // Always scope by user_id, not just subscription_id: staff chats carry
      // a null subscription_id, so without this a query could otherwise mix
      // together every staff member's conversation on the same subject.
      // Mirrors /api/chat's own three-way chat-thread scoping: a real
      // student's subscription; a staff preview of one board/grade
      // (boardId/gradeId set, its own separate thread); or unrestricted
      // staff mode (neither set).
      let query = supabase
        .from("chat_messages")
        .select("*")
        .eq("user_id", user.id)
        .eq("subject_id", subject.id);
      if (subscriptionId) {
        query = query.eq("subscription_id", subscriptionId);
      } else if (boardId && gradeId && medium) {
        query = query.is("subscription_id", null).eq("board_id", boardId).eq("grade_id", gradeId).eq("medium", medium);
      } else {
        query = query.is("subscription_id", null).is("board_id", null).is("grade_id", null);
      }

      const { data } = await query.order("created_at", { ascending: true });
      if (!cancelled) {
        setTimeline(((data as ChatMessage[]) ?? []).map((message) => ({ kind: "message", message })));
        setLoadingHistory(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [subscriptionId, subject.id, boardId, gradeId, medium]);

  // Shared with TopicSummaryMessage's onSummaryLoaded below -- its summary
  // fetch grows this bubble well after `timeline` itself last changed
  // (adding the bubble only drops in a small loading placeholder), so the
  // effect below alone always scrolled to where the placeholder's bottom
  // used to be, not the real summary's.
  // `instant`, not "smooth", for the per-tick follow during a reply's
  // reveal animation below -- re-triggering a smooth scroll roughly every
  // 28ms fights its own still-in-flight animation and reads as jittery,
  // where a plain instant scroll just keeps pace invisibly. The coarser
  // triggers (a new timeline entry, a topic summary finishing its own
  // async load) keep the smooth scroll, since those are one-off jumps.
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [timeline, scrollToBottom]);

  // Stable identity (scrollToBottom itself never changes -- see its own
  // useCallback above) so it can be passed as a MessageBubble prop without
  // defeating that component's memo(): an inline `() => scrollToBottom(...)`
  // here would be a brand-new function every ChatPanel render, which would
  // make every bubble's shallow prop comparison see a "changed" prop and
  // re-render anyway, silently undoing the whole point of memoizing them.
  const handleRevealProgress = useCallback(() => scrollToBottom("instant"), [scrollToBottom]);

  // Shared by the form's Send button and the practiceQuestionClick effect
  // below, which sends a composed message with no user-typed text or image
  // of its own. useCallback (rather than a plain function) so the effect
  // below can list it as a dependency instead of reaching for a function
  // declared later in the component.
  const performSend = useCallback(
    async (trimmed: string, image: SelectedImage | null) => {
      if ((!trimmed && !image) || sending) return;

      setError(null);
      setInput("");
      setSelectedImage(null);
      setSending(true);

      const optimisticMessage: ChatMessage = {
        id: `optimistic-${Date.now()}`,
        user_id: "",
        subscription_id: subscriptionId,
        subject_id: subject.id,
        board_id: null,
        grade_id: null,
        medium: null,
        role: "user",
        content: trimmed || "[Image]",
        created_at: new Date().toISOString(),
      };
      setTimeline((prev) => [
        ...prev,
        { kind: "message", message: optimisticMessage, previewImageUrl: image?.dataUrl },
      ]);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subjectId: subject.id,
            message: trimmed,
            image: image ? { mediaType: image.mediaType, base64: image.base64 } : undefined,
            // Harmless to send even when the toggle isn't shown/relevant --
            // the server only honors it for English-subject, non-English-medium
            // students (see ENGLISH_SUBJECT_CODE in src/app/api/chat/route.ts).
            preferEnglish,
            // Only meaningful for a staff request (resolveStaffPreviewScope
            // re-validates and ignores it otherwise) -- undefined for a real
            // student, whose scope is always subscription-derived server-side.
            previewBoardId: boardId ?? undefined,
            previewGradeId: gradeId ?? undefined,
            previewMedium: medium ?? undefined,
          }),
        });
        const body = await res.json();

        if (!res.ok) {
          throw new Error(body.error ?? "Something went wrong. Please try again.");
        }

        setTimeline((prev) => [
          ...prev.filter((entry) => entry.kind !== "message" || entry.message.id !== optimisticMessage.id),
          { kind: "message", message: body.userMessage as ChatMessage, previewImageUrl: image?.dataUrl },
          { kind: "message", message: body.assistantMessage as ChatMessage, revealOnMount: true },
        ]);
      } catch (err) {
        setTimeline((prev) =>
          prev.filter((entry) => entry.kind !== "message" || entry.message.id !== optimisticMessage.id)
        );
        setInput(trimmed);
        setSelectedImage(image);
        setError(err instanceof Error ? err.message : "Something went wrong.");
      } finally {
        setSending(false);
      }
    },
    [sending, subscriptionId, subject.id, boardId, gradeId, medium, preferEnglish]
  );

  // Re-answers an already-shown assistant reply in a new language and
  // overwrites it in place (server-side: an UPDATE of that same row, not a
  // new insert -- see regenerateMessageId in /api/chat/route.ts), rather
  // than appending a fresh message pair. Only ever called on the *last*
  // exchange in the timeline (see the effect below), mirroring exactly how
  // a topic bubble that's still the last entry stays live to the toggle --
  // a student flipping the switch right after getting a reply means "show
  // me that answer in the other language," the same expectation the topic
  // case already sets.
  const regenerateLastReply = useCallback(
    async (assistantMessageId: string, questionText: string, nextPreferEnglish: boolean) => {
      setRegeneratingMessageId(assistantMessageId);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subjectId: subject.id,
            message: questionText,
            regenerateMessageId: assistantMessageId,
            preferEnglish: nextPreferEnglish,
            previewBoardId: boardId ?? undefined,
            previewGradeId: gradeId ?? undefined,
            previewMedium: medium ?? undefined,
          }),
        });
        const body = await res.json();
        if (!res.ok || !body.assistantMessage) {
          throw new Error(body.error ?? "Could not translate the last reply.");
        }
        setTimeline((prev) =>
          prev.map((entry) =>
            entry.kind === "message" && entry.message.id === assistantMessageId
              ? { ...entry, message: body.assistantMessage as ChatMessage, revealOnMount: true }
              : entry
          )
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not translate the last reply.");
      } finally {
        setRegeneratingMessageId(null);
      }
    },
    [subject.id, boardId, gradeId, medium]
  );

  // Fires regenerateLastReply above exactly when the toggle changes *and*
  // the last thing in the timeline is an assistant reply -- the ordinary-
  // chat counterpart to the topic-bubble sync a bit further down. Genuinely
  // asynchronous (a network call), so this has to be a useEffect rather
  // than the render-body pattern the topic-bubble sync uses; the ref guard
  // plays the same role `syncedPreferEnglish` does there, firing only once
  // per real toggle flip rather than on every unrelated timeline update.
  // Skipped for an image-based question -- the image itself was never
  // persisted, so there is nothing to re-ask with; the previewImageUrl
  // check only catches this within the same browser session (it's not
  // restored on reload), which is the best that's available here.
  const regeneratedPreferEnglishRef = useRef(effectivePreferEnglish);
  useEffect(() => {
    if (regeneratedPreferEnglishRef.current === effectivePreferEnglish) return;
    regeneratedPreferEnglishRef.current = effectivePreferEnglish;

    const lastEntry = timeline[timeline.length - 1];
    if (!lastEntry || lastEntry.kind !== "message" || lastEntry.message.role !== "assistant") return;
    const pairedUser = timeline[timeline.length - 2];
    if (!pairedUser || pairedUser.kind !== "message" || pairedUser.message.role !== "user") return;
    if (pairedUser.previewImageUrl || pairedUser.message.content === "[Image]") return;

    const assistantMessageId = lastEntry.message.id;
    const questionText = pairedUser.message.content;
    // Deferred a tick rather than calling regenerateLastReply directly --
    // it sets regeneratingMessageId synchronously before its first await,
    // which the effects linter (correctly) won't allow running straight
    // off this effect's own synchronous body.
    void Promise.resolve().then(() => regenerateLastReply(assistantMessageId, questionText, effectivePreferEnglish));
  }, [effectivePreferEnglish, timeline, regenerateLastReply]);

  // A fresh clickId (even for the same topic clicked twice) drops a new
  // summary bubble at the end of the timeline, same as a message arriving.
  // Captures the toggle's current value as this bubble's own starting
  // point -- see the sync effect below for how it stays live afterward.
  useEffect(() => {
    if (!topicClick || topicClick.clickId === lastClickIdRef.current) return;
    lastClickIdRef.current = topicClick.clickId;
    setTimeline((prev) => [
      ...prev,
      {
        kind: "topic",
        entryId: topicClick.clickId,
        topic: topicClick.topic,
        preferEnglish: effectivePreferEnglish,
      },
    ]);
  }, [topicClick, effectivePreferEnglish]);

  // Keeps a topic bubble mirroring the live toggle after it changes, but
  // only when it's still the very last thing in the timeline -- a student
  // flipping the switch right after clicking a topic almost always means
  // "show me the topic I'm looking at right now in the other language."
  // The instant they send an ordinary chat message (or click a different
  // topic), that bubble is no longer what they're looking at -- it becomes
  // history, same as every earlier topic bubble, and stops reacting to
  // further flips. This must check the timeline's actual last entry, not
  // just the last *topic-kind* entry: an earlier version scanned past any
  // chat messages sent after the topic click to find that older bubble and
  // kept updating it -- flipping the toggle after asking a follow-up
  // question changed a summary the student had already moved on from,
  // while the message they'd actually just sent (and its reply) stayed
  // untouched, which is backwards from what "the latest thing" means here.
  //
  // Done directly in the render body (React's documented "adjusting state
  // when a prop changes" escape hatch -- see "You Might Not Need an Effect"),
  // not a useEffect: the state being adjusted here (timeline) isn't a
  // side-effect synchronizing with anything external, it's local state
  // derived from another piece of local state, and the guard below (bailing
  // once syncedPreferEnglish already matches) keeps this to one extra
  // render per real toggle flip rather than looping.
  const [syncedPreferEnglish, setSyncedPreferEnglish] = useState(effectivePreferEnglish);
  if (syncedPreferEnglish !== effectivePreferEnglish) {
    setSyncedPreferEnglish(effectivePreferEnglish);
    setTimeline((prev) => {
      if (prev.length === 0) return prev;
      const lastEntry = prev[prev.length - 1];
      if (lastEntry.kind !== "topic" || lastEntry.preferEnglish === effectivePreferEnglish) return prev;

      const next = [...prev];
      next[prev.length - 1] = { ...lastEntry, preferEnglish: effectivePreferEnglish };
      return next;
    });
  }

  // Same fresh-id-per-click guard as topicClick above, but sends straight
  // away rather than seeding the input for the student to edit -- an
  // earlier version left it in the input for a manual Send, which just
  // re-asked the identical already-answered question if the student didn't
  // think to add anything. Explicitly asking for a more detailed
  // explanation (rather than just resending the bare question) also gets a
  // more useful reply than the model regenerating a near-duplicate of the
  // banked answer from scratch.
  useEffect(() => {
    if (!practiceQuestionClick || practiceQuestionClick.clickId === lastPracticeClickIdRef.current) return;
    lastPracticeClickIdRef.current = practiceQuestionClick.clickId;
    const { question, answer } = practiceQuestionClick;
    void performSend(
      `I don't understand this solution -- can you explain it in more detail, step by step?\n\nQ: ${question}\nA: ${answer}`,
      null
    );
  }, [practiceQuestionClick, performSend]);

  async function handleImagePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      setError(null);
      setSelectedImage(await readImageFile(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that image.");
    }
  }

  function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    void performSend(input.trim(), selectedImage);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-6 py-3">
        <div>
          <h1 className="text-sm font-semibold">{subject.name}</h1>
          <p className="text-xs text-foreground/50">
            {isStaffUser && !medium
              ? "Staff access: unrestricted, not limited to any one syllabus."
              : `Answers are limited to this subject's syllabus, in ${
                  showLanguageToggle && preferEnglish ? "English" : medium
                }.`}
          </p>
        </div>
        {showLanguageToggle && (
          // A segmented control rather than a checkbox -- both states are
          // equally valid choices a student picks between, not an on/off
          // feature flag, so labeling both options directly reads clearer
          // than a single "use English" toggle would.
          <div
            role="group"
            aria-label="Response language"
            className="flex shrink-0 rounded-full border border-border bg-background p-0.5 text-xs"
          >
            <button
              type="button"
              onClick={() => setPreferEnglish(false)}
              aria-pressed={!preferEnglish}
              className={`rounded-full px-2.5 py-1 font-medium transition ${
                !preferEnglish ? "bg-brand text-white" : "text-foreground/60 hover:text-foreground"
              }`}
            >
              {medium}
            </button>
            <button
              type="button"
              onClick={() => setPreferEnglish(true)}
              aria-pressed={preferEnglish}
              className={`rounded-full px-2.5 py-1 font-medium transition ${
                preferEnglish ? "bg-brand text-white" : "text-foreground/60 hover:text-foreground"
              }`}
            >
              English
            </button>
          </div>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
        {loadingHistory && <p className="text-sm text-foreground/40">Loading chat history…</p>}
        {!loadingHistory && timeline.length === 0 && (
          <p className="text-sm text-foreground/40">
            Ask your first {subject.name} question below to get started.
          </p>
        )}
        {timeline.map((entry) =>
          entry.kind === "topic" ? (
            <TopicSummaryMessage
              key={entry.entryId}
              topic={entry.topic}
              preferEnglish={entry.preferEnglish}
              onSummaryLoaded={scrollToBottom}
            />
          ) : (
            <MessageBubble
              key={entry.message.id}
              entry={entry}
              subjectId={subject.id}
              isRegenerating={entry.message.id === regeneratingMessageId}
              onRevealProgress={handleRevealProgress}
            />
          )
        )}
        {sending && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-2xl border border-border bg-surface px-4 py-2 text-sm text-foreground/40">
              <LoadingIndicator label="Thinking…" />
            </div>
          </div>
        )}
      </div>

      <form onSubmit={sendMessage} className="shrink-0 border-t border-border bg-surface p-3 sm:p-4">
        {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
        {selectedImage && (
          <div className="mb-2 flex w-fit items-center gap-2 rounded-lg border border-border bg-background p-1.5 pr-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- transient local preview, never persisted */}
            <img src={selectedImage.dataUrl} alt="Selected" className="h-10 w-10 rounded object-cover" />
            <button
              type="button"
              onClick={() => setSelectedImage(null)}
              className="text-xs text-foreground/50 hover:text-foreground"
            >
              Remove
            </button>
          </div>
        )}
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            onChange={handleImagePick}
            disabled={sending}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            title="Attach a screenshot or photo"
            aria-label="Attach a screenshot or photo"
            className="shrink-0 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground/60 transition hover:text-foreground disabled:opacity-60"
          >
            📎
          </button>
          {/* A separate input+button from the one above, rather than adding
              `capture` to it -- on most mobile browsers, `capture` forces the
              camera to open directly with no gallery fallback, so this needs
              to stay a distinct entry point from "attach an existing file".
              `capture="environment"` requests the rear-facing camera, the
              natural choice for scanning a physical page; browsers that
              don't support it (most desktop browsers) just fall back to an
              ordinary file picker. */}
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            onChange={handleImagePick}
            disabled={sending}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => cameraInputRef.current?.click()}
            disabled={sending}
            title="Scan a question with your camera"
            aria-label="Scan a question with your camera"
            className="shrink-0 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground/60 transition hover:text-foreground disabled:opacity-60"
          >
            📷
          </button>
          {/* text-base (16px), not text-sm -- iOS Safari auto-zooms the whole
              page on focusing any input/textarea under 16px, which on a
              chat box a student re-focuses constantly is a real, jarring
              bug, not just a font-size preference. */}
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Ask a ${subject.name} question…`}
            disabled={sending}
            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-base outline-none focus:ring-2 focus:ring-brand disabled:opacity-60 sm:text-sm"
          />
          <button
            type="submit"
            disabled={sending || (!input.trim() && !selectedImage)}
            aria-label="Send message"
            title="Send"
            // Browser extensions (password managers, Grammarly, etc.) commonly
            // patch the `disabled` attribute on form buttons before React
            // hydrates, which triggers a false-positive hydration mismatch
            // warning here even though server and client compute the same
            // value from identical initial state.
            suppressHydrationWarning
            className="flex shrink-0 items-center gap-1 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-50 sm:px-4"
          >
            {/* Icon-only below sm: a full "Send" label was one of three
                elements competing for width in a single row on a phone,
                alongside the attach button and the input itself. */}
            <span aria-hidden="true">➤</span>
            <span className="hidden sm:inline">Send</span>
          </button>
        </div>
      </form>
    </div>
  );
}
