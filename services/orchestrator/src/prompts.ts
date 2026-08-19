import type { RetrievedChunk } from "./chapterRag.js";
import { selectRelevantTopics } from "./syllabusFilter.js";
import type { Medium, SyllabusTopic } from "./types.js";

export function buildTutorSystemPrompt(params: {
  subjectName: string;
  boardName: string;
  gradeName: string;
  medium: Medium;
  topics: SyllabusTopic[];
  message: string;
  hasImage?: boolean;
  // Chunks of admin-authored chapter content retrieved by semantic
  // similarity to `message` (see chapterRag.ts) -- mainly for English-medium
  // literature chapters, where the syllabus topic list alone ("the poem
  // 'Daffodils'") gives the model a title but not the actual text needed to
  // answer a specific comprehension question accurately. Empty/omitted for
  // the common case (no matching chapter document, or the subject has none
  // authored yet) -- the prompt reads identically to before this feature.
  referenceChunks?: RetrievedChunk[];
}): string {
  const { subjectName, boardName, gradeName, medium, topics, message, hasImage, referenceChunks } = params;

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
  // The image itself is a separate content block the model reads directly
  // (vision), not OCR'd into text first -- this just tells it what to
  // expect and how to treat a missing/short caption.
  const imageNote = hasImage
    ? "\n\nThe student has attached a screenshot or photo (e.g. of a textbook question or their own handwritten work). Read whatever text, problem, or working is shown in it and treat that as their question, even if their typed message is empty or just a short caption."
    : "";
  // Presented as reference material to consult, not an access-control rule
  // to obey the way the syllabus chapter list is -- a weak or irrelevant
  // retrieval match should just be ignored by the model rather than forced
  // into the answer (chapterRag.ts already drops anything below its own
  // similarity floor before it ever reaches here, but a mediocre match
  // above that floor can still be the wrong thing to lean on for a
  // specific question). Each chunk is labeled with its field_type when the
  // source data has one (e.g. "[vocabulary]" vs "[summary]" -- see
  // chapterDocuments.ts's pre-chunked import path), so the model knows what
  // kind of information it's looking at, and followed by its citation when
  // one exists, matching the exact "(Source: ...)" phrasing rule 6 below
  // asks it to reuse.
  const referenceSection =
    referenceChunks && referenceChunks.length > 0
      ? `\n\nReference material from this subject's chapter notes, possibly relevant to the current question:\n${referenceChunks
          .map((chunk, i) => {
            const label = chunk.fieldType ? `[${chunk.fieldType}] ` : "";
            const source = chunk.citation ? `\n(Source: ${chunk.citation})` : "";
            return `[${i + 1}] ${label}${chunk.content}${source}`;
          })
          .join("\n\n")}`
      : "";
  // Anchors rule 6's abstract instructions with a concrete pattern to match,
  // the way a worked example does more than a rule statement alone --
  // included only alongside referenceSection (nothing to anchor when there's
  // no reference material this turn) so this cost is never paid on the vast
  // majority of chat messages, which have no chapter-notes match at all.
  // Deliberately written subject/book-agnostic (no character names, titles,
  // or story specifics) since this same prompt serves every subject and
  // board this app has, not one dedicated book.
  const fewShotSection =
    referenceChunks && referenceChunks.length > 0
      ? `\n\nExamples of the response style rule 6 asks for:

Student: Why did that happen in the story?
Assistant: The material given doesn't actually explain the reason -- it only describes what happened, not why. It says the event took place and how the characters reacted to it, but the motivation behind it isn't stated. I can't confirm the "why" beyond that. (Source: Chapter 2)

Student: What happened to them after that?
Assistant: I don't have that covered in the material available to me here -- it only goes up to that point in the chapter. You may want to check your textbook or ask your teacher about what happens afterward.

Student: Give me the exact lines of that poem.
Assistant: I can't reproduce the exact original wording, but here's what it describes in my own words: it paints a quiet, everyday scene through a few simple, vivid details. For the precise text, please check your textbook copy directly.`
      : "";

  return `You are a patient, encouraging tutor for a school student studying ${subjectName} in ${gradeName} under the ${boardName} curriculum.${imageNote}

Hard rules, in order of priority:
1. Respond ONLY in ${medium}, regardless of what language the student writes in.
2. Only answer questions about ${subjectName}. If the student asks about a different subject, gently decline and remind them they can switch subjects using the left panel to ask about that subject instead.
3. Keep your answers within the ${gradeName} ${boardName} ${subjectName} syllabus, which covers these chapters: ${chapterList}. You may draw on the prerequisite knowledge needed to explain them, but do not teach content from later grades, other boards, or chapters not listed here.${detailSection}
4. If a question falls outside this syllabus (e.g. a much more advanced topic, or something from a different grade or board), say so briefly, note that it's outside the current syllabus, and offer to explain the closest syllabus-appropriate topic instead.
5. Teach, don't just answer: explain concepts clearly with simple examples appropriate for a ${gradeName} student, and show step-by-step reasoning for problems.
6. If reference material is provided below, use it if it actually helps answer accurately; ignore it if it doesn't apply. Where it does apply, ground your answer in it rather than filling gaps with outside knowledge presented as fact -- if it only partly covers the question, say plainly which part you can't confirm rather than guessing. Never quote long passages, poem lines, or dialogue verbatim from it; paraphrase and explain in your own words instead. When you rely on a specific piece of reference material, name its source in parentheses using the citation given with it, e.g. "(Source: ...)" -- if a chunk has no citation attached, name the chapter/topic it came from instead.${referenceSection}${fewShotSection}

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
export function buildStaffSystemPrompt(subjectName: string, hasImage?: boolean): string {
  const imageNote = hasImage
    ? "\n\nThey've attached a screenshot or photo. Read whatever text, problem, or working is shown in it and treat that as their question, even if their typed message is empty or just a short caption."
    : "";

  return `You are a knowledgeable tutor and subject-matter expert in ${subjectName}, talking with a member of the platform's staff (not a specific student). They have full access and are not restricted to any single board, grade, or syllabus.${imageNote}

Guidelines:
1. Only answer questions about ${subjectName}. If they ask about a different subject, point out they can switch subjects using the left panel.
2. You may draw on the full breadth of ${subjectName} across all school grade levels and boards (CBSE, ICSE, state boards, etc.) — there is no syllabus restriction.
3. Respond in whichever language they write in.
4. Be clear and precise; when relevant, note which grade level or curriculum a topic is typically associated with, since staff may be evaluating syllabus coverage.

Keep responses focused and appropriately concise for a chat interface.`;
}
