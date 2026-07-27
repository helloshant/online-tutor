"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
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
type TimelineEntry =
  | { kind: "message"; message: ChatMessage }
  | { kind: "topic"; entryId: string; topic: SyllabusTopic };

export function ChatPanel({
  subscriptionId,
  subject,
  medium,
  isStaffUser,
  topicClick,
}: {
  subscriptionId: string | null;
  subject: SubjectSummary;
  medium: Medium | null;
  isStaffUser: boolean;
  topicClick: { clickId: string; topic: SyllabusTopic } | null;
}) {
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastClickIdRef = useRef<string | null>(null);

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

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || sending) return;

    setError(null);
    setInput("");
    setSending(true);

    const optimisticMessage: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      user_id: "",
      subscription_id: subscriptionId,
      subject_id: subject.id,
      role: "user",
      content: trimmed,
      created_at: new Date().toISOString(),
    };
    setTimeline((prev) => [...prev, { kind: "message", message: optimisticMessage }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subjectId: subject.id, message: trimmed }),
      });
      const body = await res.json();

      if (!res.ok) {
        throw new Error(body.error ?? "Something went wrong. Please try again.");
      }

      setTimeline((prev) => [
        ...prev.filter((entry) => entry.kind !== "message" || entry.message.id !== optimisticMessage.id),
        { kind: "message", message: body.userMessage as ChatMessage },
        { kind: "message", message: body.assistantMessage as ChatMessage },
      ]);
    } catch (err) {
      setTimeline((prev) =>
        prev.filter((entry) => entry.kind !== "message" || entry.message.id !== optimisticMessage.id)
      );
      setInput(trimmed);
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSending(false);
    }
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
                {entry.message.content}
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

      <form onSubmit={sendMessage} className="shrink-0 border-t border-border bg-surface p-4">
        {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Ask a ${subject.name} question…`}
            disabled={sending}
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            // Browser extensions (password managers, Grammarly, etc.) commonly
            // patch the `disabled` attribute on form buttons before React
            // hydrates, which triggers a false-positive hydration mismatch
            // warning here even though server and client compute the same
            // value from identical initial state.
            suppressHydrationWarning
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
