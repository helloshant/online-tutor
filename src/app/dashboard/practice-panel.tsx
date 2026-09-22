"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { MathText } from "@/components/math-text";
import { LoadingIndicator } from "@/components/loading-indicator";
import type { Medium } from "@/lib/supabase/types";

// Same local-mirror convention as pattern-picker.tsx/topic-practice.tsx --
// never imported across the server-only orchestratorClient.ts boundary
// into a client component.
type ExerciseType = "MCQ" | "short_answer" | "long_answer" | "numerical";
const EXERCISE_TYPE_LABELS: Record<ExerciseType, string> = {
  MCQ: "MCQ",
  short_answer: "Short answer",
  long_answer: "Long answer",
  numerical: "Numerical",
};

// Kept in sync by hand with the orchestrator's own
// practiceBlueprint.ts:MAX_TOPICS_PER_PAPER and
// /api/practice-papers/route.ts's own copy of the same cap.
const MAX_TOPICS_PER_PAPER = 4;
// Same allow-list/caps as /api/practice-papers/[id]/submit/route.ts --
// checked here too so a student finds out about an unsupported file
// before spending time uploading it.
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const MAX_IMAGES_PER_SUBMISSION = 4;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

type PaperQuestion = {
  id: string;
  question: string;
  type: ExerciseType;
  marks: number;
  score: number | null;
  feedback: string | null;
};

type Paper = {
  id: string;
  chapters: string[];
  totalMarks: number;
  createdAt: string;
  questions: PaperQuestion[];
};

type SubmissionStatus = "submitted" | "grading" | "graded" | "failed";

type Submission = {
  id: string;
  status: SubmissionStatus;
  totalScore: number | null;
  maxPossibleScore: number | null;
  overallFeedback: string | null;
};

type HistoryPaper = {
  id: string;
  chapters: string[];
  totalMarks: number;
  createdAt: string;
};

// One selectable unit in the picker below -- named "topic" throughout
// (rather than "chapter") because a syllabus_topics.chapter value is NOT a
// reliable pick-one-of-these-N unit: for a literature-style subject (e.g.
// WBBSE Bengali), every story/poem in a book shares the SAME chapter value
// (the book's own title, e.g. "Bengali"), with each individual selectable
// story/poem actually living in that row's own `topic` field instead.
// Reported directly: the picker showed a single "Bengali" checkbox with no
// way to choose which story to generate a paper from. Grouping by chapter
// for DISPLAY (a heading) while selecting by individual topic id underneath
// it works for both shapes: a subject where chapter and topic are already
// distinct units (most subjects) just shows one topic per chapter heading,
// changing nothing about what a student sees or picks there.
type ChapterGroup = {
  chapter: string;
  topics: { id: string; topic: string }[];
};

// A full mock question paper a student generates on demand for their own
// chosen chapter(s) -- mixing MCQ/short/long questions from a fixed
// blueprint (see the orchestrator's practiceBlueprint.ts), then graded
// automatically from one or more photographs of the student's own
// handwritten answers. Self-contained, like TopicPractice: owns its own
// chapter selection, generated paper, and submission state.
export function PracticePanel({
  boardId,
  gradeId,
  subjectId,
  medium,
}: {
  boardId: string;
  gradeId: string;
  subjectId: string;
  medium: Medium;
}) {
  const [chapterGroups, setChapterGroups] = useState<ChapterGroup[] | null>(
    null,
  );
  const [selectedTopicIds, setSelectedTopicIds] = useState<Set<string>>(
    new Set(),
  );
  const [history, setHistory] = useState<HistoryPaper[] | null>(null);

  const [activePaper, setActivePaper] = useState<Paper | null>(null);
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [loadingPaper, setLoadingPaper] = useState(false);

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);

  // Chapter/topic list + paper history both reset on a subject/scope switch
  // -- this component is remounted per subject anyway (see
  // dashboard-shell.tsx's key on the subject id one level up for ChatPanel;
  // PracticePanel follows the same pattern), but this effect also covers a
  // staff preview's own board/grade/medium changing under an otherwise-
  // stable subject. Same query TopicList already runs, grouped the same
  // way (see ChapterGroup's own comment on why topic, not chapter, is the
  // actual selectable unit here).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("syllabus_topics")
        .select("id, chapter, topic")
        .eq("board_id", boardId)
        .eq("grade_id", gradeId)
        .eq("subject_id", subjectId)
        .eq("medium", medium)
        .order("sort_order");
      if (cancelled) return;
      const groups: ChapterGroup[] = [];
      for (const row of data ?? []) {
        const group = groups.find((g) => g.chapter === row.chapter);
        if (group) group.topics.push({ id: row.id, topic: row.topic });
        else
          groups.push({
            chapter: row.chapter,
            topics: [{ id: row.id, topic: row.topic }],
          });
      }
      setChapterGroups(groups);
    })();
    return () => {
      cancelled = true;
    };
  }, [boardId, gradeId, subjectId, medium]);

  // Returns null (rather than setting state itself) on any failure --
  // best-effort, same posture as TopicList's own progress fetch: the
  // picker/generate flow still works fine with no history shown. Kept
  // side-effect-free so both the mount effect below (which needs a
  // `cancelled` guard around its own setState) and the post-generate
  // refresh (an ordinary event handler, no such guard needed) can share
  // it without one call site accidentally setting state after unmount.
  async function fetchHistory(): Promise<HistoryPaper[] | null> {
    try {
      const res = await fetch("/api/practice-papers");
      if (!res.ok) return null;
      const body = await res.json();
      return body.papers ?? [];
    } catch {
      return null;
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const papers = await fetchHistory();
      if (!cancelled && papers) setHistory(papers);
    })();
    return () => {
      cancelled = true;
    };
  }, [subjectId]);

  function toggleTopic(topicId: string) {
    setSelectedTopicIds((prev) => {
      const next = new Set(prev);
      if (next.has(topicId)) {
        next.delete(topicId);
      } else if (next.size < MAX_TOPICS_PER_PAPER) {
        next.add(topicId);
      }
      return next;
    });
  }

  function resetToPicker() {
    setActivePaper(null);
    setSubmission(null);
    setSelectedFiles([]);
    setUploadError(null);
    setSubmitFailed(false);
    setSelectedTopicIds(new Set());
  }

  async function handleGenerate() {
    if (selectedTopicIds.size === 0 || generating) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const res = await fetch("/api/practice-papers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subjectId,
          topicIds: Array.from(selectedTopicIds),
          // Only meaningful for a staff caller previewing a specific
          // board/grade (resolveStaffPreviewScope re-validates server-side
          // rather than trusting these) -- a real student's own scope
          // always comes from their subscription regardless of what's
          // sent here, same as /api/chat's own previewBoardId/etc.
          boardId,
          gradeId,
          medium,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? "Could not generate a practice paper.");
      }
      setActivePaper(body.paper);
      setSubmission(null);
      setSelectedFiles([]);
      setSubmitFailed(false);
      void fetchHistory().then((papers) => {
        if (papers) setHistory(papers);
      });
    } catch (err) {
      setGenerateError(
        err instanceof Error
          ? err.message
          : "Could not generate a practice paper.",
      );
    } finally {
      setGenerating(false);
    }
  }

  async function handleOpenPaper(paperId: string) {
    setLoadingPaper(true);
    setGenerateError(null);
    try {
      const res = await fetch(`/api/practice-papers/${paperId}`);
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? "Could not load this practice paper.");
      }
      setActivePaper(body.paper);
      setSubmission(body.submission);
      setSelectedFiles([]);
      setSubmitFailed(false);
    } catch (err) {
      setGenerateError(
        err instanceof Error
          ? err.message
          : "Could not load this practice paper.",
      );
    } finally {
      setLoadingPaper(false);
    }
  }

  function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (picked.length === 0) return;

    setUploadError(null);
    const combined = [...selectedFiles, ...picked];
    if (combined.length > MAX_IMAGES_PER_SUBMISSION) {
      setUploadError(
        `Please attach at most ${MAX_IMAGES_PER_SUBMISSION} photos.`,
      );
      return;
    }
    for (const file of picked) {
      if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
        setUploadError("Please attach JPEG, PNG, GIF, or WebP photos only.");
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        setUploadError(`${file.name} is too large (max 15MB per photo).`);
        return;
      }
    }
    setSelectedFiles(combined);
  }

  function removeFile(index: number) {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit() {
    if (!activePaper || selectedFiles.length === 0 || submitting) return;
    setSubmitting(true);
    setSubmitFailed(false);
    setUploadError(null);
    try {
      const formData = new FormData();
      for (const file of selectedFiles) formData.append("files", file);

      const res = await fetch(`/api/practice-papers/${activePaper.id}/submit`, {
        method: "POST",
        body: formData,
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? "Could not grade this submission.");
      }

      setSubmission(body.submission);
      setActivePaper((prev) => {
        if (!prev) return prev;
        const resultsById = new Map(
          (
            body.results as { id: string; score: number; feedback: string }[]
          ).map((r) => [r.id, r]),
        );
        return {
          ...prev,
          questions: prev.questions.map((q) => {
            const result = resultsById.get(q.id);
            return result
              ? { ...q, score: result.score, feedback: result.feedback }
              : q;
          }),
        };
      });
    } catch (err) {
      setSubmitFailed(true);
      setUploadError(
        err instanceof Error ? err.message : "Could not grade this submission.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
      {!activePaper ? (
        <>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground/40">
            Practice paper
          </p>
          <p className="mb-4 text-xs text-foreground/40">
            Pick up to {MAX_TOPICS_PER_PAPER} topics to generate a mock question
            paper -- write your answers on paper, photograph them, and get them
            graded automatically.
          </p>

          {chapterGroups === null ? (
            <p className="text-sm text-foreground/50">
              <LoadingIndicator label="Loading chapters…" />
            </p>
          ) : chapterGroups.length === 0 ? (
            <p className="text-sm text-foreground/50">
              No syllabus entered yet for this subject.
            </p>
          ) : (
            <>
              <div className="space-y-4">
                {chapterGroups.map((group) => (
                  <div key={group.chapter}>
                    <h3 className="px-2 text-sm font-semibold text-foreground/80">
                      {group.chapter}
                    </h3>
                    <ul className="mt-1 space-y-0.5">
                      {group.topics.map((t) => {
                        const checked = selectedTopicIds.has(t.id);
                        const disabled =
                          !checked &&
                          selectedTopicIds.size >= MAX_TOPICS_PER_PAPER;
                        return (
                          <li key={t.id}>
                            <label
                              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                                disabled
                                  ? "opacity-40"
                                  : "cursor-pointer hover:bg-brand/5"
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={disabled}
                                onChange={() => toggleTopic(t.id)}
                                className="shrink-0"
                              />
                              <span>{t.topic}</span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>

              {selectedTopicIds.size >= MAX_TOPICS_PER_PAPER && (
                <p className="mt-2 text-xs text-foreground/40">
                  Up to {MAX_TOPICS_PER_PAPER} topics per paper.
                </p>
              )}

              {generateError && (
                <p className="mt-3 text-sm text-red-600">{generateError}</p>
              )}

              <button
                type="button"
                onClick={handleGenerate}
                disabled={selectedTopicIds.size === 0 || generating}
                className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-60"
              >
                {generating ? (
                  <LoadingIndicator label="Generating your paper…" />
                ) : (
                  "Generate paper"
                )}
              </button>
            </>
          )}

          {history && history.length > 0 && (
            <div className="mt-8 border-t border-border pt-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground/40">
                Your practice papers
              </p>
              <ul className="space-y-1.5">
                {history.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => handleOpenPaper(p.id)}
                      disabled={loadingPaper}
                      className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm transition hover:bg-brand/5 disabled:opacity-60"
                    >
                      <span className="truncate">{p.chapters.join(", ")}</span>
                      <span className="shrink-0 text-xs text-foreground/40">
                        {p.totalMarks} marks
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={resetToPicker}
            className="mb-3 text-xs text-foreground/40 hover:underline"
          >
            ← New paper
          </button>

          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground/40">
            {activePaper.chapters.join(", ")}
          </p>
          <p className="mb-4 text-xs text-foreground/40">
            Total: {activePaper.totalMarks} marks
          </p>

          <ol className="space-y-4">
            {activePaper.questions.map((q, i) => (
              <li key={q.id}>
                <p className="whitespace-pre-wrap font-medium">
                  {i + 1}.{" "}
                  <span className="mr-1 rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/50">
                    {EXERCISE_TYPE_LABELS[q.type]}
                  </span>
                  <span className="mr-1 text-xs font-normal text-foreground/40">
                    ({q.marks} mark{q.marks === 1 ? "" : "s"})
                  </span>
                  <MathText text={q.question} />
                </p>
                {q.score !== null && (
                  <p
                    className={`mt-1.5 rounded-lg p-2 text-sm ${
                      q.score <= 0
                        ? "bg-red-50 text-red-800"
                        : q.score >= q.marks
                          ? "bg-green-50 text-green-800"
                          : "bg-yellow-50 text-yellow-800"
                    }`}
                  >
                    <span className="font-semibold">
                      {q.score}/{q.marks}
                    </span>{" "}
                    {q.feedback}
                  </p>
                )}
              </li>
            ))}
          </ol>

          {submission?.status === "graded" ? (
            <div className="mt-4 space-y-2 border-t border-border pt-4">
              <p className="text-lg font-semibold">
                Total: {submission.totalScore} / {submission.maxPossibleScore}
              </p>
              {submission.overallFeedback && (
                <p className="text-sm text-foreground/70">
                  {submission.overallFeedback}
                </p>
              )}
            </div>
          ) : (
            <div className="mt-4 space-y-2 border-t border-border pt-4">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground/40">
                Upload your answer sheet
              </p>
              <p className="mb-2 text-xs text-foreground/40">
                Write your answers on paper, then photograph each page (up to{" "}
                {MAX_IMAGES_PER_SUBMISSION} photos) and upload them here.
              </p>

              <input
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                onChange={handleFilePick}
                className="text-sm"
              />

              {selectedFiles.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {selectedFiles.map((file, i) => (
                    <li
                      key={`${file.name}-${i}`}
                      className="flex items-center justify-between gap-2 rounded-lg bg-background px-2 py-1 text-xs"
                    >
                      <span className="truncate">{file.name}</span>
                      <button
                        type="button"
                        onClick={() => removeFile(i)}
                        className="shrink-0 text-foreground/40 hover:text-foreground"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {uploadError && (
                <p className="mt-2 text-sm text-red-600">{uploadError}</p>
              )}

              <button
                type="button"
                onClick={handleSubmit}
                disabled={selectedFiles.length === 0 || submitting}
                className="mt-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-60"
              >
                {submitting ? (
                  <LoadingIndicator label="Grading your answers…" />
                ) : submitFailed ? (
                  "Try grading again"
                ) : (
                  "Submit answers"
                )}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
