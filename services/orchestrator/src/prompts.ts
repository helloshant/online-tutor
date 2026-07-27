import { selectRelevantTopics } from "./syllabusFilter.js";
import type { Medium, SyllabusTopic } from "./types.js";

export function buildTutorSystemPrompt(params: {
  subjectName: string;
  boardName: string;
  gradeName: string;
  medium: Medium;
  topics: SyllabusTopic[];
  message: string;
}): string {
  const { subjectName, boardName, gradeName, medium, topics, message } = params;

  // Full chapter list (cheap: titles only) always defines the scope
  // boundary. Only topics relevant to the current question get full detail,
  // so token cost doesn't scale with syllabus size on every message.
  const chapters = [...new Set(topics.map((t) => t.chapter))];
  const relevantTopics = selectRelevantTopics(topics, message);

  const chapterList = chapters.length
    ? chapters.join(", ")
    : "(no syllabus entered yet for this board/grade/subject in the catalog -- use your general knowledge of a typical school curriculum at this level as a reasonable approximation, and mention to the student that the full syllabus isn't loaded yet)";

  const detailSection = relevantTopics.length
    ? `\n\nDetailed topics most relevant to the current question (use these for specifics; the chapter list above is the overall boundary, not everything in the syllabus has detail loaded here):\n${relevantTopics.map((t) => `- ${t.chapter}: ${t.topic}`).join("\n")}`
    : "";

  return `You are a patient, encouraging tutor for a school student studying ${subjectName} in ${gradeName} under the ${boardName} curriculum.

Hard rules, in order of priority:
1. Respond ONLY in ${medium}, regardless of what language the student writes in.
2. Only answer questions about ${subjectName}. If the student asks about a different subject, gently decline and remind them they can switch subjects using the left panel to ask about that subject instead.
3. Keep your answers within the ${gradeName} ${boardName} ${subjectName} syllabus, which covers these chapters: ${chapterList}. You may draw on the prerequisite knowledge needed to explain them, but do not teach content from later grades, other boards, or chapters not listed here.${detailSection}
4. If a question falls outside this syllabus (e.g. a much more advanced topic, or something from a different grade or board), say so briefly, note that it's outside the current syllabus, and offer to explain the closest syllabus-appropriate topic instead.
5. Teach, don't just answer: explain concepts clearly with simple examples appropriate for a ${gradeName} student, and show step-by-step reasoning for problems.

Keep responses focused and appropriately concise for a chat interface.`;
}

export function buildTopicSummaryPrompt(params: {
  subjectName: string;
  boardName: string;
  gradeName: string;
  medium: Medium;
  chapter: string;
  topic: string;
}): string {
  const { subjectName, boardName, gradeName, medium, chapter, topic } = params;
  return `You are writing a quick-reference study summary for a ${gradeName} student studying ${subjectName} under the ${boardName} curriculum.

Chapter: "${chapter}"
Topic: "${topic}"

Write ONLY in ${medium}, regardless of what language this prompt is in. Explain the core concept(s) clearly, state any key formulas/definitions/rules the student must remember, and keep it to a few short paragraphs -- this is a revision summary, not a full lesson, and it must not include practice questions or exercises.`;
}

const EXERCISE_FORMAT_INSTRUCTIONS = `Format each exercise exactly as:
Q: <question>
A: <complete worked solution, showing steps>

Separate exercises with a line containing only ---. Output nothing else: no preamble, no numbering, no closing remarks.`;

export function buildExerciseGenerationPrompt(params: {
  subjectName: string;
  boardName: string;
  gradeName: string;
  medium: Medium;
  chapter: string;
  topic: string;
  count: number;
}): string {
  const { subjectName, boardName, gradeName, medium, chapter, topic, count } = params;
  return `You are writing practice exercises for a ${gradeName} student studying ${subjectName} under the ${boardName} curriculum.

Chapter: "${chapter}"
Topic: "${topic}"

Write ONLY in ${medium}, regardless of what language this prompt is in. Generate exactly ${count} practice questions appropriate for this grade, board, and topic, each with a complete worked solution. Vary the difficulty slightly across the ${count} questions.

${EXERCISE_FORMAT_INSTRUCTIONS}`;
}

// Staff (admin/superadmin) aren't a specific grade's student and never
// subscribe, so their chat isn't locked to one board/grade/syllabus/medium --
// this is deliberately the "all privileges" unrestricted mode, mainly for
// platform staff to explore and QA subject coverage.
export function buildStaffSystemPrompt(subjectName: string): string {
  return `You are a knowledgeable tutor and subject-matter expert in ${subjectName}, talking with a member of the platform's staff (not a specific student). They have full access and are not restricted to any single board, grade, or syllabus.

Guidelines:
1. Only answer questions about ${subjectName}. If they ask about a different subject, point out they can switch subjects using the left panel.
2. You may draw on the full breadth of ${subjectName} across all school grade levels and boards (CBSE, ICSE, state boards, etc.) — there is no syllabus restriction.
3. Respond in whichever language they write in.
4. Be clear and precise; when relevant, note which grade level or curriculum a topic is typically associated with, since staff may be evaluating syllabus coverage.

Keep responses focused and appropriately concise for a chat interface.`;
}
