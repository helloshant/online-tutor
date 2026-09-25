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

// Same local-mirror convention as ExerciseType above. Wire values match the
// orchestrator's own DifficultyLevel ("Easy" | "Medium" | "Hard") exactly --
// only the UI labels differ ("Moderate"/"Difficult" read better to a student
// than "Medium"/"Hard"). "Difficult" is deliberately the top of the slider,
// not a separate "Very difficult" step -- the orchestrator's own prompt
// instruction for "Hard" already asks for "difficult to very difficult"
// questions (see prompts.ts's describeDifficultyLevel), so the slider's top
// end already covers that range rather than needing a fourth step.
type Difficulty = "Easy" | "Medium" | "Hard";
const DIFFICULTY_LEVELS: Difficulty[] = ["Easy", "Medium", "Hard"];
const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  Easy: "Easy",
  Medium: "Moderate",
  Hard: "Difficult",
};

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
// See the chapter-list effect's own comment for what this decides.
const FEW_CHAPTERS_THRESHOLD = 3;

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

// The selectable unit in the picker below is the CHAPTER, not the
// individual sub-topics under it -- reported directly: a per-topic picker
// exposed every fine-grained learning point as its own checkbox, which
// asked for a level of manual curation nobody wanted ("I don't want to let
// the student choose sub-topics"). Selection is also uncapped -- a student
// can tick as many chapters as they like, up to the whole syllabus (see
// the orchestrator's own MAX_BLUEPRINT_SCALE_CHAPTERS for why a large
// selection still produces one reasonably-sized paper rather than an
// ever-growing one).

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
  const [chapters, setChapters] = useState<string[] | null>(null);
  const [selectedChapters, setSelectedChapters] = useState<Set<string>>(
    new Set(),
  );
  // Defaults to Moderate. Deliberately NOT reset by resetToPicker() below --
  // a sticky per-session preference (a student who sets Difficult and
  // generates one paper most likely wants the next one at the same level
  // too, not silently reset to Moderate every time they click "New paper").
  const [difficulty, setDifficulty] = useState<Difficulty>("Medium");
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

  // Chapter list + paper history both reset on a subject/scope switch --
  // this component is remounted per subject anyway (see dashboard-shell.tsx's
  // key on the subject id one level up for ChatPanel; PracticePanel follows
  // the same pattern), but this effect also covers a staff preview's own
  // board/grade/medium changing under an otherwise-stable subject.
  //
  // Reported directly, three times, for three different subjects (WBBSE
  // Bengali, WBBSE Geography, CBSE Hindi): some subjects' syllabus_topics
  // rows are organized around a small number of BOOKS (e.g. "Sparsh",
  // "Ganit Prakash", "Sahitya Onushilon") rather than real chapters -- the
  // book's own title sits in `chapter`, with the real, chapter-sized
  // divisions (each story/poem, or a grammar/writing-skills catch-all)
  // actually living in each row's own `topic` field instead. A picker
  // grounded strictly in `chapter` degenerates to one or two enormous,
  // useless checkboxes for a subject shaped this way.
  //
  // Distinguishing this from an ordinary, well-structured subject can't be
  // done by topic count alone -- confirmed directly against real data: a
  // single genuine chapter can legitimately have up to 10 topics under it
  // (e.g. WBBSE Grade 9 Bengali-medium Math's own numbered chapters), while
  // a degenerate "book" bucket can have as few as 5. What DOES cleanly
  // separate every real case checked: a well-structured subject has MANY
  // distinct chapter values (Grade 9 Math has 20+; Grade 9 Geography's
  // English medium has 5), while a book-organized one has only one or two
  // (a single book, or a book plus a small grammar/skills catch-all).
  // Falls back to `topic` (flattened, ungrouped) only when the whole
  // subject has few distinct chapters -- for every ordinary subject, this
  // changes nothing. The fallback topics are themselves full chapter-sized
  // units (confirmed directly: "Earth as a Planet", "সাখী", "Reading
  // Comprehension", ...), not fine-grained sub-points, so this is NOT the
  // sub-topic picker that was explicitly ruled out -- it's the same "pick
  // a chapter" UI, just sourced from whichever column actually carries
  // that granularity for this subject.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("syllabus_topics")
        .select("chapter, topic")
        .eq("board_id", boardId)
        .eq("grade_id", gradeId)
        .eq("subject_id", subjectId)
        .eq("medium", medium)
        .order("sort_order");
      if (cancelled) return;
      const rows = data ?? [];
      const distinctChapters = [...new Set(rows.map((t) => t.chapter))];
      setChapters(
        distinctChapters.length > FEW_CHAPTERS_THRESHOLD
          ? distinctChapters
          : [...new Set(rows.map((t) => t.topic))],
      );
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
  //
  // Scoped to this exact board/grade/subject/medium -- reported directly:
  // with no scope filter, this showed every paper the account had ever
  // generated across every subject/board/grade, most obviously for a staff
  // account previewing several different combinations (a paper generated
  // under one preview showed up while now previewing a completely
  // different one).
  async function fetchHistory(): Promise<HistoryPaper[] | null> {
    try {
      const params = new URLSearchParams({
        subjectId,
        boardId,
        gradeId,
        medium,
      });
      const res = await fetch(`/api/practice-papers?${params}`);
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
    // fetchHistory closes over exactly these same four props -- listing it
    // too would just re-run this on every render (it's a fresh function
    // identity each time), not on a real scope change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, gradeId, subjectId, medium]);

  function toggleChapter(chapter: string) {
    setSelectedChapters((prev) => {
      const next = new Set(prev);
      if (next.has(chapter)) next.delete(chapter);
      else next.add(chapter);
      return next;
    });
  }

  function resetToPicker() {
    setActivePaper(null);
    setSubmission(null);
    setSelectedFiles([]);
    setUploadError(null);
    setSubmitFailed(false);
    setSelectedChapters(new Set());
  }

  async function handleGenerate() {
    if (selectedChapters.size === 0 || generating) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const res = await fetch("/api/practice-papers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subjectId,
          chapters: Array.from(selectedChapters),
          // Only meaningful for a staff caller previewing a specific
          // board/grade (resolveStaffPreviewScope re-validates server-side
          // rather than trusting these) -- a real student's own scope
          // always comes from their subscription regardless of what's
          // sent here, same as /api/chat's own previewBoardId/etc.
          boardId,
          gradeId,
          medium,
          difficulty,
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

  // min-w-0 here (in addition to the history row's own, see below) is the
  // real fix -- reported directly, still reproducing after that first fix:
  // this div is ITSELF a flex item (dashboard-shell.tsx mounts it inside a
  // `flex flex-col` wrapper, itself nested inside more flex ancestors).
  // Without min-w-0 at THIS level too, a sufficiently long, unbreakable
  // line deep inside (the history row's chapter list) can still stretch
  // this whole flex item wider to fit it, which then makes the inner row's
  // own `w-full`/`truncate` moot -- "100% of a container that grew to fit
  // the content" never actually clips anything. This is the same flexbox
  // min-width:auto quirk as the inner fix, just one containment boundary
  // higher up the tree.
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
      {!activePaper ? (
        <>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground/62">
            Practice paper
          </p>
          <p className="mb-4 text-xs text-foreground/62">
            Pick the chapters to generate a mock question paper from -- write
            your answers on paper, photograph them, and get them graded
            automatically.
          </p>

          {chapters === null ? (
            <p className="text-sm text-foreground/68">
              <LoadingIndicator label="Loading chapters…" />
            </p>
          ) : chapters.length === 0 ? (
            <p className="text-sm text-foreground/68">
              No syllabus entered yet for this subject.
            </p>
          ) : (
            <>
              <ul className="space-y-1">
                {chapters.map((chapter) => {
                  const checked = selectedChapters.has(chapter);
                  return (
                    <li key={chapter}>
                      <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-brand/5">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleChapter(chapter)}
                          className="shrink-0"
                        />
                        <span>{chapter}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>

              <div className="mt-4">
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="font-semibold uppercase tracking-wide text-foreground/62">
                    Difficulty
                  </span>
                  <span className="font-medium text-foreground/82">
                    {DIFFICULTY_LABELS[difficulty]}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={DIFFICULTY_LEVELS.length - 1}
                  step={1}
                  value={DIFFICULTY_LEVELS.indexOf(difficulty)}
                  onChange={(e) =>
                    setDifficulty(DIFFICULTY_LEVELS[Number(e.target.value)])
                  }
                  className="w-full accent-brand"
                />
                <div className="mt-1 flex justify-between text-[10px] text-foreground/62">
                  <span>Easy</span>
                  <span>Moderate</span>
                  <span>Difficult</span>
                </div>
              </div>

              {generateError && (
                <p className="mt-3 text-sm text-red-600">{generateError}</p>
              )}

              <button
                type="button"
                onClick={handleGenerate}
                disabled={selectedChapters.size === 0 || generating}
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
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground/62">
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
                      {/* min-w-0 is required for truncate to actually take
                          effect on a flex child -- without it, a flex item's
                          default min-width:auto stops it shrinking below its
                          own text's natural width, so a long chapter list
                          just overflows the button instead of ellipsizing
                          (reported directly with a screenshot showing
                          exactly that overflow). */}
                      <span className="min-w-0 truncate">
                        {p.chapters.join(", ")}
                      </span>
                      <span className="shrink-0 text-xs text-foreground/62">
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
            className="mb-3 text-xs text-foreground/62 hover:underline"
          >
            ← New paper
          </button>

          <p className="text-lg font-bold">Mock Exam</p>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground/62">
            {activePaper.chapters.join(", ")}
          </p>
          <p className="mb-4 text-xs text-foreground/62">
            Total: {activePaper.totalMarks} marks
          </p>

          <ol className="space-y-4">
            {activePaper.questions.map((q, i) => (
              <li key={q.id}>
                <p className="whitespace-pre-wrap font-medium">
                  {i + 1}.{" "}
                  <span className="mr-1 rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/68">
                    {EXERCISE_TYPE_LABELS[q.type]}
                  </span>
                  <span className="mr-1 text-xs font-normal text-foreground/62">
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
                <p className="text-sm text-foreground/82">
                  {submission.overallFeedback}
                </p>
              )}
            </div>
          ) : (
            <div className="mt-4 space-y-2 border-t border-border pt-4">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground/62">
                Upload your answer sheet
              </p>
              <p className="mb-2 text-xs text-foreground/62">
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
                        className="shrink-0 text-foreground/62 hover:text-foreground"
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
