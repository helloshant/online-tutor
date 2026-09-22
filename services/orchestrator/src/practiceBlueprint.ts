import type { ExerciseType } from "./types.js";

// A student picking their own question counts/marks per type was
// deliberately ruled out for v1 (see the accompanying plan) -- this fixed
// blueprint is what /v1/practice-paper/generate builds a paper from
// instead. Long-answer stays fixed at 2 regardless of chapter count: a
// paper never needs more than 2 deep-dive questions, keeping both
// generation cost and the number of photographed pages a student needs to
// write bounded.
//
// Named MAX_TOPICS_PER_PAPER, not MAX_CHAPTERS_PER_PAPER: the web app's own
// picker selects individual syllabus_topics rows, not distinct chapter
// names -- a chapter value isn't a reliable "pick one of these" unit for
// every subject (a literature-style subject can have many stories/poems
// sharing one chapter/book name, each living in its own `topic` field
// instead, see practice-panel.tsx's own ChapterGroup comment). `chapterCount`
// below still means what it says -- the number of DISTINCT chapters among
// the topics actually selected, which can be smaller than the number of
// topics picked (e.g. 4 stories from the same book is chapterCount=1) --
// this cap just also doubles as the ceiling on how many topics (and thus
// LLM generation calls) one request can ask for at all.
export const MAX_TOPICS_PER_PAPER = 4;

export type BlueprintSection = {
  type: ExerciseType;
  count: number;
  marksEach: number;
};

export function buildPracticeBlueprint(
  chapterCount: number,
): BlueprintSection[] {
  const extra = Math.max(0, Math.min(chapterCount, MAX_TOPICS_PER_PAPER) - 1);
  return [
    { type: "MCQ", count: 5 + extra, marksEach: 1 },
    { type: "short_answer", count: 3 + extra, marksEach: 2 },
    { type: "long_answer", count: 2, marksEach: 5 },
  ];
}
