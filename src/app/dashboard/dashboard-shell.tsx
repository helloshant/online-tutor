"use client";

import { useState } from "react";
import Link from "next/link";
import { LogoutButton } from "@/components/logout-button";
import { ChatPanel } from "./chat-panel";
import type { Medium } from "@/lib/supabase/types";

interface SubjectSummary {
  id: string;
  name: string;
  code: string;
}

export function DashboardShell({
  userName,
  subscriptionId,
  boardName,
  gradeName,
  medium,
  subjects,
  isStaffUser,
}: {
  userName: string;
  subscriptionId: string | null;
  boardName: string;
  gradeName: string;
  medium: Medium | null;
  subjects: SubjectSummary[];
  isStaffUser: boolean;
}) {
  const [selectedSubjectId, setSelectedSubjectId] = useState<string | null>(
    subjects[0]?.id ?? null
  );

  const selectedSubject = subjects.find((s) => s.id === selectedSubjectId) ?? null;

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-surface px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-brand">TutorOps</span>
          <span className="hidden text-xs text-foreground/50 sm:inline">
            {isStaffUser ? "Staff access · all subjects" : `${boardName} · ${gradeName} · ${medium}`}
          </span>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="hidden text-foreground/70 sm:inline">{userName}</span>
          {isStaffUser && (
            <Link href="/admin" className="font-medium text-brand hover:underline">
              Admin
            </Link>
          )}
          <LogoutButton className="font-medium text-foreground/60 hover:text-foreground" />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 overflow-y-auto border-r border-border bg-surface p-3 sm:w-64">
          <h2 className="px-2 text-xs font-semibold uppercase tracking-wide text-foreground/40">
            {isStaffUser ? "All subjects" : "Your subjects"}
          </h2>
          <nav className="mt-2 space-y-1">
            {subjects.map((subject) => (
              <button
                key={subject.id}
                type="button"
                onClick={() => setSelectedSubjectId(subject.id)}
                className={`block w-full rounded-lg px-3 py-2 text-left text-sm transition ${
                  subject.id === selectedSubjectId
                    ? "bg-brand text-white font-medium"
                    : "text-foreground/80 hover:bg-brand/5"
                }`}
              >
                {subject.name}
              </button>
            ))}
            {subjects.length === 0 && (
              <p className="px-2 text-sm text-foreground/50">No subjects subscribed.</p>
            )}
          </nav>
        </aside>

        <main className="flex min-h-0 flex-1 flex-col">
          {selectedSubject ? (
            <ChatPanel
              key={selectedSubject.id}
              subscriptionId={subscriptionId}
              subject={selectedSubject}
              medium={medium}
              isStaffUser={isStaffUser}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-foreground/50">
              Select a subject to start chatting.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
