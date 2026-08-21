"use client";

import { useState } from "react";
import Link from "next/link";
import { LogoutButton } from "@/components/logout-button";
import { ChatPanel } from "./chat-panel";
import { SyllabusPanel } from "./syllabus-panel";
import { PracticePanel } from "./practice-panel";
import { InboxPanel } from "./inbox-panel";
import { TopicList } from "./topic-list";
import type { Medium, SyllabusTopic } from "@/lib/supabase/types";

interface SubjectSummary {
  id: string;
  name: string;
  code: string;
}

// The English subject teaches the English language itself, so its syllabus
// (chapters, poems, prose) is inherently written in English regardless of
// which medium the rest of a student's board/grade is taught in -- unlike
// every other subject, where the syllabus is authored per-medium because
// the *content itself* is translated (see "Medium-scoped syllabus storage"
// in the README). A Bengali-medium student's English subject therefore
// reads the same single English-medium syllabus an English-medium student
// would, not a separate Bengali-tagged copy -- there is only ever one
// canonical syllabus per board/grade for this one subject. Mirrors
// ENGLISH_SUBJECT_CODE in src/app/api/chat/route.ts.
const ENGLISH_SUBJECT_CODE = "ENG";

// The medium a subject's syllabus/topics should actually be fetched under
// -- almost always the student's own subscribed medium, except for English
// (see the constant above). `medium` can be null here (staff mode), but
// every call site below only reaches this once `medium` is already known
// non-null (guarded by `!isStaffUser && medium` in JSX), so the cast is
// safe in context, not a blind assertion.
function syllabusMediumFor(subject: SubjectSummary, medium: Medium): Medium {
  return subject.code === ENGLISH_SUBJECT_CODE ? "English" : medium;
}

// "subjects" only exists as a destination below lg -- desktop switches
// subjects via the always-visible sidebar instead, independent of this tab
// state entirely. Same for "topics": desktop already has SyllabusPanel as a
// persistent sidebar, so a "Topics" destination only has meaning on mobile,
// where it's the only way to reach topic browsing at all (see topic-list.tsx).
type MainTab = "subjects" | "topics" | "chat" | "practice" | "inbox";

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
  // Set when "Ask about this" is clicked on a Practice result -- handed to
  // ChatPanel so it can seed a pending context (shown above the input,
  // folded into the next message sent) rather than leaving the student to
  // retype the question from scratch to get help with it. Same fresh-id-
  // per-click shape as topicClick, for the same reason: clicking the same
  // result twice should still re-seed it.
  const [practiceQuestionClick, setPracticeQuestionClick] = useState<{
    clickId: string;
    question: string;
    answer: string;
  } | null>(null);
  // Collapsed as soon as a subject is active (including the default
  // preselected one on first load) so the syllabus panel gets the room --
  // expanded back only via the explicit toggle below. Desktop-only state:
  // the sidebar this controls doesn't render below lg at all.
  const [subjectsCollapsed, setSubjectsCollapsed] = useState(selectedSubjectId !== null);
  // Which main-area surface is visible -- all stay mounted (see the main
  // content below) so switching tabs never loses any panel's local state
  // (the chat timeline's ephemeral topic bubbles, or an in-progress
  // Practice search).
  const [mainTab, setMainTab] = useState<MainTab>("chat");

  const selectedSubject = subjects.find((s) => s.id === selectedSubjectId) ?? null;
  const hasSyllabusScope = !isStaffUser && Boolean(boardId && gradeId && medium);

  function handleSelectSubject(subjectId: string) {
    setSelectedSubjectId(subjectId);
    setTopicClick(null);
    setPracticeQuestionClick(null);
    setSubjectsCollapsed(true);
    setMainTab("chat");
  }

  // Shared by SyllabusPanel's sidebar (desktop), the Topics tab (mobile),
  // and the mobile Subjects screen indirectly via handleSelectSubject above
  // -- always jump to the Chat tab on select, since that's where the
  // resulting summary bubble actually appears. Without this, clicking a
  // topic while on Practice (or Topics itself) would drop the bubble into a
  // panel the student isn't currently looking at, with no visible feedback
  // that anything happened.
  function handleSelectTopic(topic: SyllabusTopic) {
    setTopicClick({ clickId: crypto.randomUUID(), topic });
    setMainTab("chat");
  }

  // Same "jump to Chat" reasoning as handleSelectTopic above: seeding
  // context into a panel the student isn't looking at would be invisible.
  function handleAskAboutPractice(question: string, answer: string) {
    setPracticeQuestionClick({ clickId: crypto.randomUUID(), question, answer });
    setMainTab("chat");
  }

  const mobileNavItems: { tab: MainTab; icon: string; label: string }[] = [
    { tab: "subjects", icon: "📚", label: "Subjects" },
    ...(hasSyllabusScope ? [{ tab: "topics" as const, icon: "📖", label: "Topics" }] : []),
    { tab: "chat", icon: "💬", label: "Chat" },
    ...(hasSyllabusScope ? [{ tab: "practice" as const, icon: "✏️", label: "Practice" }] : []),
    ...(!isStaffUser ? [{ tab: "inbox" as const, icon: "🔔", label: "Inbox" }] : []),
  ];

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
        {/* Desktop-only: below lg, subject switching happens through the
            "Subjects" bottom-nav destination instead (see below) -- a
            persistent sidebar, even collapsed to a 56px icon strip,
            permanently eats width on a phone-sized viewport. */}
        <aside
          className={`hidden shrink-0 overflow-y-auto border-r border-border bg-surface transition-[width] lg:block ${
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
            medium={syllabusMediumFor(selectedSubject, medium)}
            selectedTopicId={topicClick?.topic.id ?? null}
            onSelectTopic={handleSelectTopic}
          />
        )}

        <main className="flex min-h-0 flex-1 flex-col">
          {mainTab === "subjects" ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <h1 className="mb-3 text-xs font-semibold uppercase tracking-wide text-foreground/40">
                {isStaffUser ? "All subjects" : "Your subjects"}
              </h1>
              {subjects.length === 0 ? (
                <p className="text-sm text-foreground/50">No subjects subscribed.</p>
              ) : (
                <ul className="space-y-1.5">
                  {subjects.map((subject) => (
                    <li key={subject.id}>
                      <button
                        type="button"
                        onClick={() => handleSelectSubject(subject.id)}
                        className={`block w-full rounded-lg px-4 py-3 text-left text-sm font-medium transition ${
                          subject.id === selectedSubjectId
                            ? "bg-brand text-white"
                            : "bg-surface text-foreground/80 hover:bg-brand/5"
                        }`}
                      >
                        {subject.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : selectedSubject ? (
            <>
              {/* Desktop-only: below lg, Topics/Chat/Practice are reached
                  through the bottom nav instead, which also covers Subjects
                  (desktop switches subjects via the sidebar, so doesn't need
                  a Subjects tab here). */}
              {hasSyllabusScope && (
                <div className="hidden shrink-0 gap-1 border-b border-border bg-surface px-6 pt-2 lg:flex">
                  {(["chat", "practice", "inbox"] as const).map((tab) => (
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

              {/* All panels stay mounted and toggle via display, not
                  conditional rendering, so switching tabs never discards any
                  panel's state. */}
              {boardId && gradeId && medium && !isStaffUser && (
                <div className={mainTab === "topics" ? "min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6" : "hidden"}>
                  <p className="mb-3 text-xs text-foreground/40">
                    Tap a topic to drop its summary into the chat.
                  </p>
                  <TopicList
                    boardId={boardId}
                    gradeId={gradeId}
                    subjectId={selectedSubject.id}
                    medium={syllabusMediumFor(selectedSubject, medium)}
                    selectedTopicId={topicClick?.topic.id ?? null}
                    onSelectTopic={handleSelectTopic}
                  />
                </div>
              )}
              <div className={mainTab === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
                <ChatPanel
                  key={selectedSubject.id}
                  subscriptionId={subscriptionId}
                  subject={selectedSubject}
                  medium={medium}
                  isStaffUser={isStaffUser}
                  topicClick={topicClick}
                  practiceQuestionClick={practiceQuestionClick}
                />
              </div>
              {boardId && gradeId && medium && !isStaffUser && (
                <div className={mainTab === "practice" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
                  <PracticePanel
                    key={selectedSubject.id}
                    subjectId={selectedSubject.id}
                    active={mainTab === "practice"}
                    onAskAbout={handleAskAboutPractice}
                  />
                </div>
              )}
              {/* Not subject-scoped (a student's broadcasts don't belong to
                  any one subject), but nested here anyway rather than as a
                  sibling of the selectedSubject branch -- reachable the
                  moment at least one subject is selected, which for a
                  subscribed student with any subjects at all is always. */}
              {!isStaffUser && (
                <div className={mainTab === "inbox" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
                  <InboxPanel />
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

      {/* Mobile-only primary navigation -- replaces both the old chip row
          and the old mobile "Topics" top-tab with a single bottom nav, so
          there's exactly one navigation surface on a phone instead of two
          competing ones. pb-[env(...)] keeps the bar clear of the iOS home
          indicator gesture area. */}
      <nav
        aria-label="Main"
        className="flex shrink-0 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        {mobileNavItems.map((item) => (
          <button
            key={item.tab}
            type="button"
            onClick={() => setMainTab(item.tab)}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-xs font-medium transition ${
              mainTab === item.tab ? "text-brand" : "text-foreground/50 hover:text-foreground"
            }`}
          >
            <span className="text-lg" aria-hidden="true">
              {item.icon}
            </span>
            {item.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
