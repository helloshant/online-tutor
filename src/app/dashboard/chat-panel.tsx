"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { ChatMessage, Medium } from "@/lib/supabase/types";

interface SubjectSummary {
  id: string;
  name: string;
  code: string;
}

export function ChatPanel({
  subscriptionId,
  subject,
  medium,
}: {
  subscriptionId: string;
  subject: SubjectSummary;
  medium: Medium;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    supabase
      .from("chat_messages")
      .select("*")
      .eq("subscription_id", subscriptionId)
      .eq("subject_id", subject.id)
      .order("created_at", { ascending: true })
      .then(({ data }) => {
        if (!cancelled) {
          setMessages((data as ChatMessage[]) ?? []);
          setLoadingHistory(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [subscriptionId, subject.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

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
    setMessages((prev) => [...prev, optimisticMessage]);

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

      setMessages((prev) => [
        ...prev.filter((m) => m.id !== optimisticMessage.id),
        body.userMessage as ChatMessage,
        body.assistantMessage as ChatMessage,
      ]);
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticMessage.id));
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
          Answers are limited to this subject&apos;s syllabus, in {medium}.
        </p>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
        {loadingHistory && <p className="text-sm text-foreground/40">Loading chat history…</p>}
        {!loadingHistory && messages.length === 0 && (
          <p className="text-sm text-foreground/40">
            Ask your first {subject.name} question below to get started.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ${
                m.role === "user"
                  ? "bg-brand text-white"
                  : "border border-border bg-surface text-foreground"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
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
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
