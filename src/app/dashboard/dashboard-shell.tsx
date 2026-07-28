"use client";

import { useState } from "react";
import Link from "next/link";
import { LogoutButton } from "@/components/logout-button";
import { ChatPanel } from "./chat-panel";
import { SyllabusPanel } from "./syllabus-panel";
import { PracticePanel } from "./practice-panel";
import type { Medium, SyllabusTopic } from "@/lib/supabase/types";

interface SubjectSummary {
  id: string;
  name: string;
  code: string;
}

export function DashboardShell({
  userName,
  subscriptionId,
  boardId,
  gradeId,
  boardName,
  gradeName,
  medium,
  subjects,
  isStaffUser,
}: {
  userName: string;
  subscriptionId: string | null;
  boardId: string | null;
  gradeId: string | null;
  boardName: string;
  gradeName: string;
  medium: Medium | null;
  subjects: SubjectSummary[];
  isStaffUser: boolean;
}) {
  const [selectedSubjectId, setSelectedSubjectId] = useState<string | null>(
    subjects[0]?.id ?? null
  );
  // A fresh id per click (not just the topic) so clicking the same topic
  // twice still drops a new summary bubble into the chat, same as sending
  // the same message twice would. Cleared on subject switch so a topic
  // clicked under one subject never leaks into another subject's chat.
  const [topicClick, setTopicClick] = useState<{ clickId: string; topic: SyllabusTopic } | null>(null);
  // Collapsed as soon as a subject is active (including the default
  // preselected one on first load) so the syllabus panel gets the room --
  // expanded back only via the explicit toggle below.
  const [subjectsCollapsed, setSubjectsCollapsed] = useState(selectedSubjectId !== null);
  // Which of the two main-area surfaces is visible -- both stay mounted
  // (see the main content below) so switching tabs never loses either
  // panel's local state (the chat timeline's ephemeral topic bubbles, or
  // an in-progress Practice search).
  const [mainTab, setMainTab] = useState<"chat" | "practice">("chat");

  const selectedSubject = subjects.find((s) => s.id === selectedSubjectId) ?? null;

  function handleSelectSubject(subjectId: string) {
    setSelectedSubjectId(subjectId);
    setTopicClick(null);
    setSubjectsCollapsed(true);
    setMainTab("chat");
  }

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
        <aside
          className={`shrink-0 overflow-y-auto border-r border-border bg-surface transition-[width] ${
            subjectsCollapsed ? "w-14 p-2" : "w-56 p-3 sm:w-64"
          }`}
        >
          <div className={`flex items-center ${subjectsCollapsed ? "justify-center" : "justify-between"}`}>
            {!subjectsCollapsed && (
              <h2 className="px-2 text-xs font-semibold uppercase tracking-wide text-foreground/40">
                {isStaffUser ? "All subjects" : "Your subjects"}
              </h2>
            )}
            <button
              type="button"
              onClick={() => setSubjectsCollapsed((collapsed) => !collapsed)}
              title={subjectsCollapsed ? "Expand subjects" : "Collapse subjects"}
              aria-label={subjectsCollapsed ? "Expand subjects" : "Collapse subjects"}
              className="rounded p-1.5 text-foreground/50 transition hover:bg-brand/5 hover:text-foreground"
            >
              {subjectsCollapsed ? "»" : "«"}
            </button>
          </div>
          <nav className={`mt-2 space-y-1 ${subjectsCollapsed ? "flex flex-col items-center" : ""}`}>
            {subjects.map((subject) => (
              <button
                key={subject.id}
                type="button"
                onClick={() => handleSelectSubject(subject.id)}
                title={subject.name}
                className={`rounded-lg text-sm transition ${
                  subjectsCollapsed
                    ? "flex h-9 w-9 items-center justify-center text-xs font-semibold"
                    : "block w-full px-3 py-2 text-left"
                } ${
                  subject.id === selectedSubjectId
                    ? "bg-brand text-white font-medium"
                    : "text-foreground/80 hover:bg-brand/5"
                }`}
              >
                {subjectsCollapsed ? subject.code.slice(0, 2).toUpperCase() : subject.name}
              </button>
            ))}
            {subjects.length === 0 && !subjectsCollapsed && (
              <p className="px-2 text-sm text-foreground/50">No subjects subscribed.</p>
            )}
          </nav>
        </aside>

        {selectedSubject && boardId && gradeId && medium && !isStaffUser && (
          <SyllabusPanel
            key={`${selectedSubject.id}-syllabus`}
            boardId={boardId}
            gradeId={gradeId}
            subjectId={selectedSubject.id}
            medium={medium}
            selectedTopicId={topicClick?.topic.id ?? null}
            onSelectTopic={(topic) => setTopicClick({ clickId: crypto.randomUUID(), topic })}
          />
        )}

        <main className="flex min-h-0 flex-1 flex-col">
          {selectedSubject ? (
            <>
              {!isStaffUser && boardId && gradeId && medium && (
                <div className="flex shrink-0 gap-1 border-b border-border bg-surface px-4 pt-2 sm:px-6">
                  {(["chat", "practice"] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setMainTab(tab)}
                      className={`rounded-t-lg px-3 py-1.5 text-sm font-medium capitalize transition ${
                        mainTab === tab
                          ? "border border-b-0 border-border bg-background text-brand"
                          : "text-foreground/50 hover:text-foreground"
                      }`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>
              )}

              {/* Both panels stay mounted and toggle via display, not conditional
                  rendering, so switching tabs never discards either one's state. */}
              <div className={mainTab === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
                <ChatPanel
                  key={selectedSubject.id}
                  subscriptionId={subscriptionId}
                  subject={selectedSubject}
                  medium={medium}
                  isStaffUser={isStaffUser}
                  topicClick={topicClick}
                />
              </div>
              {!isStaffUser && boardId && gradeId && medium && (
                <div className={mainTab === "practice" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
                  <PracticePanel
                    key={selectedSubject.id}
                    boardId={boardId}
                    gradeId={gradeId}
                    subjectId={selectedSubject.id}
                    medium={medium}
                  />
                </div>
              )}
            </>
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
