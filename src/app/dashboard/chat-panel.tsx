"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { MathText } from "@/components/math-text";
import { TopicSummaryMessage } from "./topic-summary-message";
import type { ChatMessage, Medium, SyllabusTopic } from "@/lib/supabase/types";

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
type TimelineEntry =
  | { kind: "message"; message: ChatMessage; previewImageUrl?: string }
  | { kind: "topic"; entryId: string; topic: SyllabusTopic };

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

export function ChatPanel({
  subscriptionId,
  subject,
  medium,
  isStaffUser,
  topicClick,
  practiceQuestionClick,
  chapterNoteClick,
}: {
  subscriptionId: string | null;
  subject: SubjectSummary;
  medium: Medium | null;
  isStaffUser: boolean;
  topicClick: { clickId: string; topic: SyllabusTopic } | null;
  practiceQuestionClick: { clickId: string; question: string; answer: string } | null;
  chapterNoteClick: { clickId: string; chapter: string; topic: string; content: string } | null;
}) {
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState<SelectedImage | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastClickIdRef = useRef<string | null>(null);
  const lastPracticeClickIdRef = useRef<string | null>(null);
  const lastChapterNoteClickIdRef = useRef<string | null>(null);
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
      let query = supabase
        .from("chat_messages")
        .select("*")
        .eq("user_id", user.id)
        .eq("subject_id", subject.id);
      query = subscriptionId ? query.eq("subscription_id", subscriptionId) : query.is("subscription_id", null);

      const { data } = await query.order("created_at", { ascending: true });
      if (!cancelled) {
        setTimeline(((data as ChatMessage[]) ?? []).map((message) => ({ kind: "message", message })));
        setLoadingHistory(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [subscriptionId, subject.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [timeline]);

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
          }),
        });
        const body = await res.json();

        if (!res.ok) {
          throw new Error(body.error ?? "Something went wrong. Please try again.");
        }

        setTimeline((prev) => [
          ...prev.filter((entry) => entry.kind !== "message" || entry.message.id !== optimisticMessage.id),
          { kind: "message", message: body.userMessage as ChatMessage, previewImageUrl: image?.dataUrl },
          { kind: "message", message: body.assistantMessage as ChatMessage },
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
    [sending, subscriptionId, subject.id]
  );

  // A fresh clickId (even for the same topic clicked twice) drops a new
  // summary bubble at the end of the timeline, same as a message arriving.
  useEffect(() => {
    if (!topicClick || topicClick.clickId === lastClickIdRef.current) return;
    lastClickIdRef.current = topicClick.clickId;
    setTimeline((prev) => [
      ...prev,
      { kind: "topic", entryId: topicClick.clickId, topic: topicClick.topic },
    ]);
  }, [topicClick]);

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

  // Same "send straight away" reasoning as practiceQuestionClick above, but
  // a chapter-note excerpt isn't a solution the student is stuck on -- it's
  // reference text they found via search, so the framing asks for more
  // explanation/context around it rather than claiming not to understand a
  // "solution" that was never a Q&A pair to begin with.
  useEffect(() => {
    if (!chapterNoteClick || chapterNoteClick.clickId === lastChapterNoteClickIdRef.current) return;
    lastChapterNoteClickIdRef.current = chapterNoteClick.clickId;
    const { chapter, topic, content } = chapterNoteClick;
    void performSend(
      `Can you explain this in more detail?\n\nFrom "${chapter} — ${topic}":\n${content}`,
      null
    );
  }, [chapterNoteClick, performSend]);

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
      <div className="shrink-0 border-b border-border bg-surface px-6 py-3">
        <h1 className="text-sm font-semibold">{subject.name}</h1>
        <p className="text-xs text-foreground/50">
          {isStaffUser
            ? "Staff access: unrestricted, not limited to any one syllabus."
            : `Answers are limited to this subject's syllabus, in ${medium}.`}
        </p>
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
            <TopicSummaryMessage key={entry.entryId} topic={entry.topic} />
          ) : (
            <div
              key={entry.message.id}
              className={`flex ${entry.message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ${
                  entry.message.role === "user"
                    ? "bg-brand text-white"
                    : "border border-border bg-surface text-foreground"
                }`}
              >
                {entry.previewImageUrl && (
                  // A transient client-side data URL, never persisted, so
                  // next/image's remote-loader/optimization machinery doesn't apply.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={entry.previewImageUrl}
                    alt="Attached"
                    className="mb-2 max-h-48 rounded-lg border border-white/20"
                  />
                )}
                {entry.message.content !== "[Image]" && <MathText text={entry.message.content} />}
              </div>
            </div>
          )
        )}
        {sending && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-2xl border border-border bg-surface px-4 py-2 text-sm text-foreground/40">
              Thinking…
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
