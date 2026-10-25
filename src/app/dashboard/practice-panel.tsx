"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { MathText } from "@/components/math-text";
import { LoadingIndicator } from "@/components/loading-indicator";
import type { Medium } from "@/lib/supabase/types";

// Same local-mirror convention as pattern-picker.tsx/topic-practice.tsx --
// never imported across the server-only orchestratorClient.ts boundary
// into a client component. Widened with the real CBSE board-exam section
// types reported as wanted: 'sa' (Short Answer, 3 marks -- distinct from
// the original 'short_answer', relabeled "VSA" below at 2 marks),
// 'assertion_reasoning' (1 mark, fixed 4-option format), and 'case_study'
// (a shared scenario split into 3 independently-graded sub-parts, 1+1+2
// marks) -- see the orchestrator's own PracticePaperQuestionType comment
// for why these three live in their OWN union rather than widening the
// app-wide ExerciseType used elsewhere in this app (topic practice,
// pattern picker, chat).
type ExerciseType =
  | "MCQ"
  | "short_answer"
  | "long_answer"
  | "numerical"
  | "sa"
  | "assertion_reasoning"
  | "case_study";
// short_answer/long_answer relabeled "VSA"/"LA" here now that the
// genuinely distinct SA (3 marks) and Assertion-Reasoning badges also
// exist alongside them -- "Short answer" next to a new "SA" badge would
// read as the same thing twice at a glance.
const EXERCISE_TYPE_LABELS: Record<ExerciseType, string> = {
  MCQ: "MCQ",
  short_answer: "VSA",
  long_answer: "LA",
  numerical: "Numerical",
  sa: "SA",
  assertion_reasoning: "Assertion-Reason",
  case_study: "Case Study",
};

// Same local-mirror convention as pattern-picker.tsx/topic-summary-message.tsx's
// own identical constant -- see their shared comment on why this is subject
// CODE, not name, and why only these five.
const NUMERICAL_SUBJECT_CODES = new Set(["MATH", "PHY", "CHEM", "SC", "PS"]);

// Percentage (0-100) of the paper's fixed total question count that should
// be each type -- see the orchestrator's own practiceBlueprint.ts/
// QuestionMix comments. Reported directly as wanted: "options to select
// how much percentage of the topics should be MCQ, Short answer, and Long
// Answer," plus Numerical for Physics/Chemistry-type subjects -- this was
// deliberately out of scope for v1 (a fixed 20 MCQ/15 short/6 long
// composition, see that file's own git history), reopened here.
//
// Two different defaults, not one with numerical defaulted to 0 -- a
// numerical-eligible subject gets a real slice of numerical by default
// (20%) rather than requiring every student to discover and manually turn
// it on; an ineligible subject never shows the slider at all (see
// availableTypes below), so its own default has no numerical key to carry.
// Both default sets are deliberately round numbers for a picker UI, not a
// strict reproduction of the real CBSE paper's own ratio (18 MCQ/2 A-R/5
// VSA/6 SA/4 LA/3 case-study) -- the whole point of this feature is that a
// student can change these anyway, there's nothing special about matching
// a real paper's exact proportions.
const DEFAULT_TYPE_MIX: Record<ExerciseType, number> = {
  MCQ: 40,
  assertion_reasoning: 5,
  short_answer: 15,
  sa: 15,
  long_answer: 10,
  case_study: 15,
  numerical: 0,
};
const DEFAULT_NUMERICAL_TYPE_MIX: Record<ExerciseType, number> = {
  MCQ: 30,
  assertion_reasoning: 5,
  short_answer: 15,
  sa: 10,
  long_answer: 10,
  case_study: 10,
  numerical: 20,
};

// Mirrors the orchestrator's own practiceBlueprint.ts constants of the
// same name -- see that file's own comment on why a bound exists at all
// (1 LLM call per question, so an unbounded count is unbounded cost/time).
// DEFAULT matches the original hardcoded blueprint's own total (20 MCQ +
// 15 short + 6 long = 41) exactly, so a student who never touches this
// control gets the same paper length as before this feature existed.
const MIN_QUESTION_COUNT = 10;
const MAX_QUESTION_COUNT = 60;
const DEFAULT_QUESTION_COUNT = 41;

// Same local-mirror convention as ExerciseType above. Wire values match the
// orchestrator's own DifficultyLevel ("Easy" | "Medium" | "Hard") exactly --
// only the UI labels differ ("Moderate"/"Difficult" read better to a student
// than "Medium"/"Hard"). "Difficult" is deliberately the top option, not a
// separate "Very difficult" choice -- the orchestrator's own prompt
// instruction for "Hard" already asks for "difficult to very difficult"
// questions (see prompts.ts's describeDifficultyLevel), so that top option
// already covers that range rather than needing a fourth choice.
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
  // Set only for a Case Study sub-part -- see the orchestrator's own
  // PracticePaperQuestion.groupId/scenario comment. Consecutive questions
  // sharing the same groupId are one scenario's own 3 sub-parts, rendered
  // as one grouped card (see buildDisplayItems below).
  groupId?: string;
  scenario?: string;
};

type Paper = {
  id: string;
  chapters: string[];
  totalMarks: number;
  createdAt: string;
  questions: PaperQuestion[];
};

// One entry in the active paper's own rendered list -- either an ordinary
// single question, or a whole Case Study scenario's 3 sub-parts grouped
// under one shared heading/number, matching how a real exam paper numbers
// a case study as ONE question with lettered sub-parts rather than 3
// separate ones. `questions` is already in server-assigned sortOrder, and
// a scenario's 3 sub-parts are always pushed consecutively at generation
// time (see the orchestrator's own /v1/practice-paper/generate dispatch
// loop), so grouping by consecutive matching groupId is safe -- no need to
// handle a case study's sub-parts ever being interleaved with other
// questions.
type DisplayItem =
  | { kind: "question"; number: number; question: PaperQuestion }
  | {
      kind: "caseStudy";
      number: number;
      scenario: string;
      subparts: PaperQuestion[];
    };

function buildDisplayItems(questions: PaperQuestion[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  let number = 1;
  for (let i = 0; i < questions.length; ) {
    const q = questions[i];
    if (q.groupId) {
      const subparts: PaperQuestion[] = [];
      while (i < questions.length && questions[i].groupId === q.groupId) {
        subparts.push(questions[i]);
        i += 1;
      }
      items.push({ kind: "caseStudy", number, scenario: q.scenario ?? "", subparts });
    } else {
      items.push({ kind: "question", number, question: q });
      i += 1;
    }
    number += 1;
  }
  return items;
}

const SUBPART_LABELS = ["(i)", "(ii)", "(iii)"];

// Shared score/feedback bar, used for both an ordinary question and a
// Case Study sub-part -- pulled out once both needed the identical JSX
// rather than duplicating it (a sub-part is graded as its own independent
// question, see server.ts's own comment on why, so this needed no change
// at all to work for them, just reuse).
function QuestionFeedback({ q }: { q: PaperQuestion }) {
  if (q.score === null) return null;
  return (
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
  );
}

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
  subjectCode,
  medium,
}: {
  boardId: string;
  gradeId: string;
  subjectId: string;
  // See NUMERICAL_SUBJECT_CODES' own comment -- gates whether the type-mix
  // picker below offers a Numerical slider at all.
  subjectCode: string;
  medium: Medium;
}) {
  const numericalEligible = NUMERICAL_SUBJECT_CODES.has(subjectCode);
  // Every available type for THIS subject, in display order -- drives both
  // which sliders render and what availableTypes.length "100% split among
  // N types" math the picker below does. The 6 CBSE-style types are always
  // offered, every subject -- only Numerical is subject-gated (see
  // NUMERICAL_SUBJECT_CODES' own comment), appended last when eligible.
  const availableTypes: ExerciseType[] = [
    "MCQ",
    "assertion_reasoning",
    "short_answer",
    "sa",
    "long_answer",
    "case_study",
    ...(numericalEligible ? (["numerical"] as const) : []),
  ];

  const [chapters, setChapters] = useState<string[] | null>(null);
  const [selectedChapters, setSelectedChapters] = useState<Set<string>>(
    new Set(),
  );
  // Defaults to Moderate. Deliberately NOT reset by resetToPicker() below --
  // a sticky per-session preference (a student who sets Difficult and
  // generates one paper most likely wants the next one at the same level
  // too, not silently reset to Moderate every time they click "New paper").
  const [difficulty, setDifficulty] = useState<Difficulty>("Medium");
  // Sticky per-session preference, same reasoning as difficulty above --
  // deliberately NOT reset by resetToPicker(). Seeded once from whichever
  // default set applies to this subject (see numericalEligible above);
  // genuinely a `useState` initializer function, not a bare value, so it
  // only runs once at mount rather than re-evaluating (and silently
  // overwriting anything the student already typed) on every render.
  const [typeMix, setTypeMix] = useState<Record<ExerciseType, number>>(() =>
    numericalEligible ? DEFAULT_NUMERICAL_TYPE_MIX : DEFAULT_TYPE_MIX,
  );
  const typeMixTotal = availableTypes.reduce((sum, t) => sum + (typeMix[t] || 0), 0);
  // Sticky per-session preference, same reasoning as difficulty/typeMix
  // above -- deliberately NOT reset by resetToPicker().
  const [questionCount, setQuestionCount] = useState(DEFAULT_QUESTION_COUNT);
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

  // Clamped to 0-100 and rounded to a whole percent here rather than left
  // to the <input type="number"> element's own min/max/step (which only
  // constrain the spinner arrows, not direct typing/pasting) -- a student
  // typing "150" or "-5" should land on a real, in-range value immediately,
  // not something the running total below has to explain is invalid.
  function setTypeMixValue(type: ExerciseType, raw: string) {
    const parsed = Math.round(Number(raw));
    const clamped = Number.isFinite(parsed)
      ? Math.max(0, Math.min(100, parsed))
      : 0;
    setTypeMix((prev) => ({ ...prev, [type]: clamped }));
  }

  // Same clamp-immediately reasoning as setTypeMixValue above -- a student
  // typing "500" or "0" should land on a real, in-range value right away,
  // not something a separate validation message has to explain is invalid
  // (unlike typeMixTotal, which DOES need that -- there's no single value
  // to clamp a percentage split down to).
  function setQuestionCountValue(raw: string) {
    const parsed = Math.round(Number(raw));
    const clamped = Number.isFinite(parsed)
      ? Math.max(MIN_QUESTION_COUNT, Math.min(MAX_QUESTION_COUNT, parsed))
      : DEFAULT_QUESTION_COUNT;
    setQuestionCount(clamped);
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
    if (selectedChapters.size === 0 || generating || typeMixTotal !== 100) return;
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
          // Only this subject's own availableTypes -- an ineligible
          // subject's leftover `numerical: 0` from DEFAULT_TYPE_MIX never
          // gets sent, so the server-side numerical-eligibility check
          // never even has a nonzero value to see.
          questionMix: Object.fromEntries(
            availableTypes.map((t) => [t, typeMix[t] || 0]),
          ),
          totalQuestions: questionCount,
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
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground/65">
            Practice paper
          </p>
          <p className="mb-4 text-xs text-foreground/65">
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
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-foreground/65">
                  Difficulty
                </span>
                <div className="flex gap-2">
                  {DIFFICULTY_LEVELS.map((level) => (
                    <label
                      key={level}
                      className={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-sm transition ${
                        difficulty === level
                          ? "border-brand bg-brand/10 font-medium text-brand"
                          : "border-border text-foreground/75 hover:bg-foreground/5"
                      }`}
                    >
                      <input
                        type="radio"
                        name="difficulty"
                        value={level}
                        checked={difficulty === level}
                        onChange={() => setDifficulty(level)}
                        className="accent-brand"
                      />
                      {DIFFICULTY_LABELS[level]}
                    </label>
                  ))}
                </div>
              </div>

              {/* Reported directly, as a follow-up to the type-mix picker
                  just below: "allow to set the number of questions" too --
                  see MIN/MAX_QUESTION_COUNT's own comment on the bound
                  (generation is 1 LLM call per question). Placed BEFORE
                  the type-mix picker, not after, since "how many
                  questions" is the more natural thing to settle first --
                  typeMixTotal's own split then applies to whatever total
                  is set here. */}
              <div className="mt-4">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="font-semibold uppercase tracking-wide text-foreground/65">
                    Number of questions
                  </span>
                  <span className="flex items-center gap-2">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={MIN_QUESTION_COUNT}
                      max={MAX_QUESTION_COUNT}
                      step={1}
                      value={questionCount}
                      onChange={(e) => setQuestionCountValue(e.target.value)}
                      className="w-24 rounded border border-border bg-background px-1.5 py-1 text-sm text-foreground"
                    />
                    <span className="text-foreground/65">
                      ({MIN_QUESTION_COUNT}-{MAX_QUESTION_COUNT})
                    </span>
                  </span>
                </label>
              </div>

              {/* Reported directly: "give the users options to select how
                  much percentage of the topics should be MCQ, Short
                  answer, and Long Answer," plus Numerical for Physics/
                  Chemistry-type subjects -- see availableTypes' own
                  comment on the subject gating. Percentages are of the
                  paper's own total question count above (not marks), same
                  as the orchestrator's own QuestionMix -- see
                  practiceBlueprint.ts. Number inputs, not sliders: a
                  slider reads fine for "roughly more of this, less of
                  that" but gives no way to land on an exact value like 35%
                  without a lot of fiddly dragging, and the running total
                  below needs an exact number to validate against anyway. */}
              <div className="mt-4">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-foreground/65">
                  Question mix
                </span>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {availableTypes.map((type) => (
                    <label
                      key={type}
                      className="flex flex-col gap-1 rounded-lg border border-border px-2 py-1.5 text-xs"
                    >
                      <span className="text-foreground/75">
                        {EXERCISE_TYPE_LABELS[type]}
                      </span>
                      <span className="flex items-center gap-1">
                        <input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={100}
                          step={5}
                          value={typeMix[type] ?? 0}
                          onChange={(e) =>
                            setTypeMixValue(type, e.target.value)
                          }
                          className="w-full min-w-0 rounded border border-border bg-background px-1.5 py-1 text-sm text-foreground"
                        />
                        <span className="text-foreground/65">%</span>
                      </span>
                    </label>
                  ))}
                </div>
                <p
                  className={`mt-1.5 text-xs ${
                    typeMixTotal === 100
                      ? "text-foreground/65"
                      : "font-medium text-red-600"
                  }`}
                >
                  {typeMixTotal === 100
                    ? "Total: 100%"
                    : `Total: ${typeMixTotal}% -- must add up to 100%`}
                </p>
              </div>

              {generateError && (
                <p className="mt-3 text-sm text-red-600">{generateError}</p>
              )}

              <button
                type="button"
                onClick={handleGenerate}
                disabled={
                  selectedChapters.size === 0 ||
                  generating ||
                  typeMixTotal !== 100
                }
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
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground/65">
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
                      <span className="shrink-0 text-xs text-foreground/65">
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
            className="mb-3 text-xs text-foreground/65 hover:underline"
          >
            ← New paper
          </button>

          <p className="text-lg font-bold">Mock Exam</p>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground/65">
            {activePaper.chapters.join(", ")}
          </p>
          <p className="mb-4 text-xs text-foreground/65">
            Total: {activePaper.totalMarks} marks
          </p>

          <ol className="space-y-4">
            {buildDisplayItems(activePaper.questions).map((item) =>
              item.kind === "question" ? (
                <li key={item.question.id}>
                  <p className="whitespace-pre-wrap font-medium">
                    {item.number}.{" "}
                    <span className="mr-1 rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/68">
                      {EXERCISE_TYPE_LABELS[item.question.type]}
                    </span>
                    <span className="mr-1 text-xs font-normal text-foreground/65">
                      ({item.question.marks} mark{item.question.marks === 1 ? "" : "s"})
                    </span>
                    <MathText text={item.question.question} />
                  </p>
                  <QuestionFeedback q={item.question} />
                </li>
              ) : (
                // A Case Study scenario -- one question number, the shared
                // scenario shown once, then its 3 sub-parts each with their
                // own marks and (once graded) their own independent
                // feedback bar. See DisplayItem's own comment.
                <li key={item.subparts[0]?.groupId ?? item.number}>
                  <p className="whitespace-pre-wrap font-medium">
                    {item.number}.{" "}
                    <span className="mr-1 rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/68">
                      Case Study
                    </span>
                    <span className="mr-1 text-xs font-normal text-foreground/65">
                      (
                      {item.subparts.reduce((sum, sp) => sum + sp.marks, 0)}{" "}
                      marks)
                    </span>
                    <MathText text={item.scenario} />
                  </p>
                  <ol className="mt-2 space-y-3 pl-4">
                    {item.subparts.map((sp, i) => (
                      <li key={sp.id}>
                        <p className="whitespace-pre-wrap font-medium">
                          {SUBPART_LABELS[i] ?? `(${i + 1})`}{" "}
                          <span className="mr-1 text-xs font-normal text-foreground/65">
                            ({sp.marks} mark{sp.marks === 1 ? "" : "s"})
                          </span>
                          <MathText text={sp.question} />
                        </p>
                        <QuestionFeedback q={sp} />
                      </li>
                    ))}
                  </ol>
                </li>
              ),
            )}
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
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground/65">
                Upload your answer sheet
              </p>
              <p className="mb-2 text-xs text-foreground/65">
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
                        className="shrink-0 text-foreground/65 hover:text-foreground"
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
