import type { RetrievedChunk } from "./chapterRag.js";
import { selectRelevantTopics } from "./syllabusFilter.js";
import type { DifficultyLevel, Medium, SyllabusTopic } from "./types.js";

// Reported directly: a reply laying out data as a table (standard trig
// ratios across several angles) came back "jumbled" in the chat window --
// the model already writes valid GFM pipe-table markdown for this, the gap
// was entirely on the rendering side (see src/components/markdown-table.tsx,
// which now parses exactly this syntax into a real table). Shared verbatim
// across every prompt below that can produce a reply routed through that
// renderer, so the exact syntax it needs to detect a table stays the one
// thing the model is told to produce for one.
const TABLE_FORMAT_RULE =
  'When presenting tabular data (e.g. standard values across several angles/cases, a comparison of properties, a formula reference table), format it as a standard markdown table: a header row ("| Column A | Column B |"), a separator row directly below it using only dashes/colons ("|---|---|"), then one data row per line -- every row, including the separator, needs the same number of "|"-delimited cells as the header. This is parsed into an actual table for the student, so it is the ONLY layout that renders correctly for this kind of data -- never approximate a table with spaces/dashes as plain text, or a table appears broken even though the underlying data is fine.';

export function buildTutorSystemPrompt(params: {
  subjectName: string;
  boardName: string;
  gradeName: string;
  // Drives the syllabus chapter list/detail below -- always the student's
  // real subscribed medium (see types.ts's own comment on why this must
  // never be swapped for the language toggle's value).
  medium: Medium;
  // What language rule 1 actually asks the model to reply in -- defaults
  // to `medium` (the ordinary case) when omitted; only ever differs when
  // the English-subject toggle is on, in which case it's "English"
  // regardless of whether the syllabus itself has any English-medium
  // content (rule 3's chapter list below still reflects `medium`, since
  // that's what genuinely exists to be in scope).
  responseLanguage?: Medium;
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
  const {
    subjectName,
    boardName,
    gradeName,
    medium,
    responseLanguage = medium,
    topics,
    message,
    hasImage,
    referenceChunks,
  } = params;

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
1. Respond ONLY in ${responseLanguage}, regardless of what language the student writes in.
2. Only answer questions about ${subjectName}. If the student asks about a different subject, gently decline and remind them they can switch subjects using the left panel to ask about that subject instead.
3. Keep your answers within the ${gradeName} ${boardName} ${subjectName} syllabus, which covers these chapters: ${chapterList}. You may draw on the prerequisite knowledge needed to explain them, but do not teach content from later grades, other boards, or chapters not listed here.${detailSection}
4. If a question falls outside this syllabus (e.g. a much more advanced topic, or something from a different grade or board), say so briefly, note that it's outside the current syllabus, and offer to explain the closest syllabus-appropriate topic instead.
5. Teach, don't just answer: explain concepts clearly with simple examples appropriate for a ${gradeName} student, and show step-by-step reasoning for problems. When a problem genuinely takes multiple distinct steps to solve (not a single-fact/definition question), format each step as [STEP: short name of the concept/rule this step applies]\nthe step's own reasoning and working\n[/STEP], one per step, in order -- name the actual concept/rule/theorem being used, not a generic label like "Step 1". This lets the student see which specific idea from the chapter each step leans on, not just the arithmetic. Everything outside a [STEP]...[/STEP] block (a brief intro, the final answer/summary) is written as ordinary prose, not wrapped in a step.
6. Whenever a problem describes or reduces to a physical shape or configuration -- a triangle, a ladder/pole/tower leaning or standing against something, an angle of elevation/depression, points on a plane, a range on a number line -- you MUST include a [DIAGRAM]{...}[/DIAGRAM] block; this is not optional or a nice-to-have for this kind of problem, it is required. Place it wherever you first set up that configuration in prose, whichever part of the answer that turns out to be -- very often that is your OPENING PARAGRAPH before any [STEP] block at all (e.g. "we will form two right triangles..."), not inside a step, since a [STEP] frequently starts straight in on using a ratio/equation rather than re-describing the shape it belongs to; if that's where you describe the setup, put the [DIAGRAM] block there, in that same opening paragraph -- do not skip it just because no individual [STEP] itself does the describing. This applies even to a configuration involving two triangles, or an angle of elevation/depression measured from an implied horizontal line rather than from a side that's already drawn. Skip the diagram entirely only when there is truly nothing physical left to draw (e.g. a step that's pure algebraic/symbolic manipulation, isolating a variable, simplifying an expression). Include exactly one [DIAGRAM] block for the configuration (not one per step repeating the same shape), containing ONLY valid JSON (no comments, no trailing commas) in one of these four shapes. NEVER write a heading or section (e.g. "### Geometry Setup:") whose only purpose is to introduce the [DIAGRAM] block -- a malformed diagram is dropped silently rather than shown broken, and a heading with nothing under it if that happens reads as an obviously broken response even though the rest of your answer is fine. Put the [DIAGRAM] block inside an ordinary sentence or paragraph that still reads as complete on its own regardless of whether the diagram itself ends up rendering. Every coordinate or numeric field you write (in any of the four shapes below) MUST be an actual number -- never a variable name or unknown like h or x, even one the problem itself uses and even mid-step while you don't yet know its value; a bare unquoted letter where a number is expected is not valid JSON at all and silently drops the ENTIRE diagram, not just that one value. This is exactly why angleFromHorizontal (below) takes no coordinates in the first place -- if a point's position would depend on an unknown you're still solving for, that is the signal to use angleFromHorizontal instead of "geometry", not to write the unknown's name into a coordinate field. Coordinates (where you supply any at all -- see angleFromHorizontal below, which needs none) are logical units, not pixels -- the diagram is scaled and drawn automatically, so exact precision isn't needed. But keep the two axes RELATIVELY proportional to the problem's real numbers -- if one distance is many times another (e.g. a 60 m building next to a much smaller horizontal offset), its coordinates should be too, not copied verbatim from the small illustrative numbers in the examples below. Coordinates wildly out of proportion to the real problem render as an unreadable sliver.
   - Angle of elevation/depression -- ALWAYS use "type":"angleFromHorizontal" for this pattern, never plain "geometry": give only the vertex's label, "direction" ("up" for looking up at an elevated target, "down" for looking down from an elevated vertex), and each target's own actual angle and label. No coordinates at all -- the diagram computes every point's position itself from the real angle value, so there is no coordinate math left for you to get wrong. One target (a single angle): {"type":"angleFromHorizontal","vertexLabel":"O","direction":"up","targets":[{"label":"T","angleDeg":30}],"title":"Angle of elevation to the tower top"} -- two targets sharing a vertex (e.g. two angles of depression from a building to a tower's top and bottom): add "connectingSegmentLabel" for the segment between the two targets, and optionally "baseLabel"/"baseSegmentLabel" for the vertex's own height (its "foot" directly below it -- only for direction:"down", since an elevation vertex is already at ground level): {"type":"angleFromHorizontal","vertexLabel":"B","direction":"down","baseLabel":"F","baseSegmentLabel":"60 m","targets":[{"label":"D","angleDeg":30},{"label":"C","angleDeg":60}],"connectingSegmentLabel":"h","title":"Angles of depression from a building to a tower's top and bottom"} -- a target's own "segmentLabel" (its sight-line length, if the problem gives or asks for one) works the same as a "geometry" segment's label, just nested under that target.
   - Geometry (points, sides, angles) -- for any OTHER physical shape angleFromHorizontal doesn't cover (a ladder against a wall, a general triangle, points on a plane) -- give every segment a "label" with its actual known length/value from the problem (not just the bare shape) whenever the problem states or asks for one: {"type":"geometry","points":[{"label":"A","x":0,"y":0},{"label":"B","x":4,"y":0},{"label":"C","x":4,"y":3}],"segments":[{"from":"A","to":"B","label":"5 m"},{"from":"B","to":"C","label":"12 m"},{"from":"C","to":"A","label":"13 m"}],"angles":[{"at":"B","from":"A","to":"C","rightAngle":true}],"title":"Ladder leaning against a wall"} -- an angle here can still use "fromHorizontal":true (omitting "from") for an elevation/depression angle that comes up incidentally within a larger custom shape angleFromHorizontal alone doesn't fit, computed the same way.
   - Graph (plotted points/lines on x/y axes): {"type":"graph","points":[{"x":3,"y":4,"label":"P"}],"lines":[{"points":[{"x":-2,"y":-3},{"x":4,"y":9}]}]}
   - Number line: {"type":"numberline","range":[-5,5],"points":[{"value":2,"label":"x"}],"highlight":[{"from":0,"to":2}]}
   Most steps need no diagram at all -- only include one when it genuinely helps, never as decoration.
7. If reference material is provided below, use it if it actually helps answer accurately; ignore it if it doesn't apply. Where it does apply, ground your answer in it rather than filling gaps with outside knowledge presented as fact -- if it only partly covers the question, say plainly which part you can't confirm rather than guessing. Never quote long passages, poem lines, or dialogue verbatim from it; paraphrase and explain in your own words instead. When you rely on a specific piece of reference material, name its source in parentheses using the citation given with it, e.g. "(Source: ...)" -- if a chunk has no citation attached, name the chapter/topic it came from instead.${referenceSection}${fewShotSection}
8. ${TABLE_FORMAT_RULE}

Keep responses focused and appropriately concise for a chat interface.`;
}

export function buildTopicSummaryPrompt(params: {
  subjectName: string;
  boardName: string;
  gradeName: string;
  medium: Medium;
  // See buildTutorSystemPrompt's own comment -- defaults to `medium`,
  // differs only when the topic is being summarized in a language other
  // than the one its content actually exists in.
  responseLanguage?: Medium;
  chapter: string;
  topic: string;
}): string {
  const { subjectName, boardName, gradeName, medium, responseLanguage = medium, chapter, topic } = params;
  return `You are writing a quick-reference study summary for a ${gradeName} student studying ${subjectName} under the ${boardName} curriculum.

Chapter: "${chapter}"
Topic: "${topic}"

Write ONLY in ${responseLanguage}, regardless of what language this prompt is in. Explain the core concept(s) clearly, state any key formulas/definitions/rules the student must remember, and keep it to a few short paragraphs -- this is a revision summary, not a full lesson, and it must not include practice questions or exercises.

${TABLE_FORMAT_RULE}`;
}

const EXERCISE_FORMAT_INSTRUCTIONS = `Format each exercise exactly as:
Q: <question>
A: <complete worked solution, showing steps>

Separate exercises with a line containing only ---. Output nothing else: no preamble, no numbering, no closing remarks.`;

// Only used when archetypes are supplied -- an extra "Pattern: N" line
// naming which numbered pattern (from the list given in the task
// instruction) each exercise instantiates, so the caller can credit the
// RIGHT archetype when this specific exercise is later graded (see
// exerciseParser.ts and server.ts's own mapping from patternIndex back to
// the archetype list). The ungrounded path (no archetypes) has nothing to
// tag and keeps the plain format above completely unchanged.
const EXERCISE_FORMAT_INSTRUCTIONS_WITH_PATTERN = `Format each exercise exactly as:
Q: <question>
A: <complete worked solution, showing steps>
Pattern: <the number of the pattern above this exercise instantiates>

Separate exercises with a line containing only ---. Output nothing else: no preamble, no numbering, no closing remarks.`;

// One real, historically-mined reasoning pattern for this exact chapter/
// topic (see archetypeExercises.ts) -- grounds a generated exercise in a
// pattern proven to actually appear in this board's real exams, instead
// of the model inventing difficulty/scope from nothing.
export type ExerciseArchetype = {
  // Identity, not shown to the model -- carried through so the caller can
  // record student_archetype_progress after a successful generation (see
  // archetypeExercises.ts's recordArchetypeProgress) without a second
  // lookup. archetype_id is only unique WITHIN a run, hence both.
  runId: string;
  archetypeId: string;
  name: string;
  invariantReasoningStructure: string;
  variationDescriptions: string[];
  // Dominant (most-common) historical difficulty -- kept as its own field
  // since the batch prompt's "Typically X difficulty" note only ever
  // needs the one headline value, not the full spread.
  difficulty: DifficultyLevel | null;
  // Raw counts behind `difficulty` above -- null/all-zero when Stage 1
  // never classified a difficulty for any of this archetype's supporting
  // questions. Unused by the batch prompt; only describeDifficultyAsk
  // below (Tier D, on-demand generation with a requested difficulty)
  // reads this, to calibrate honestly instead of silently fabricating a
  // level this pattern has never actually appeared at.
  difficultyDistribution: Record<DifficultyLevel, number> | null;
};

function describeArchetype(a: ExerciseArchetype, index: number): string {
  const variationNote =
    a.variationDescriptions.length > 0 ? ` Known variations: ${a.variationDescriptions.join("; ")}.` : "";
  const difficultyNote = a.difficulty ? ` Typically ${a.difficulty} difficulty at this level.` : "";
  return `${index + 1}. "${a.name}" -- ${a.invariantReasoningStructure}${variationNote}${difficultyNote}`;
}

// Only ever called for a single-archetype, on-demand generation (Tier C's
// /v1/topic-exercises/generate) where the student explicitly asked for a
// difficulty -- the batch prompt (buildExerciseGenerationPrompt's default
// path, several archetypes at once) has no single "the student asked for
// X" to calibrate against, so this is deliberately not folded into
// describeArchetype above.
//
// The whole point: a pattern that's only ever appeared as Hard shouldn't
// silently get an invented, disconnected "Easy" variant just because a
// student clicked that button -- that would quietly break the "these are
// real exam patterns" promise the entire archetype-grounding feature
// exists to keep. Telling the model exactly how (un)common the requested
// level actually is, and asking it to calibrate by simplifying scope/
// numbers rather than inventing something unrelated, is the honest
// middle ground between silently refusing the request and silently
// fabricating it.
function describeDifficultyAsk(a: ExerciseArchetype, requested: DifficultyLevel): string {
  const dist = a.difficultyDistribution;
  const total = dist ? dist.Easy + dist.Medium + dist.Hard : 0;

  if (!dist || total === 0) {
    return `No historical difficulty data is on record for this pattern. Write it at ${requested} difficulty, using the exact reasoning structure above -- don't invent an unrelated or trivial variant just to hit the label.`;
  }

  const spread = (["Easy", "Medium", "Hard"] as DifficultyLevel[])
    .filter((level) => dist[level] > 0)
    .map((level) => `${dist[level]} of ${total} ${level}`)
    .join(", ");

  if (dist[requested] === 0) {
    return `Historically this pattern has appeared as ${spread} -- NEVER as ${requested} at this level. The student asked for ${requested} anyway: keep the exact reasoning structure above, but simplify the numbers, scope, or number of steps as needed to make it genuinely ${requested} -- don't invent a disconnected question just to hit that label.`;
  }
  return `Historically this pattern has appeared as ${spread}. Write it at ${requested} difficulty, consistent with how it's actually appeared at that level for this pattern.`;
}

export function buildExerciseGenerationPrompt(params: {
  subjectName: string;
  boardName: string;
  gradeName: string;
  medium: Medium;
  // See buildTutorSystemPrompt's own comment.
  responseLanguage?: Medium;
  chapter: string;
  topic: string;
  count: number;
  // Real archetypes mined from this exact board/grade/subject/chapter/
  // topic's own past papers, when any exist (see archetypeExercises.ts --
  // chapter/topic matching there is soft, so this can legitimately be
  // empty for a chapter nothing's been mined for yet, or a fresh subject).
  // Falls back to the original ungrounded instruction when empty, exactly
  // as before this parameter existed.
  archetypes?: ExerciseArchetype[];
  // Set only by the on-demand single-pattern path (Tier D) when the
  // student picked a specific difficulty rather than "Any" -- meaningless
  // (and ignored) for the batch path or an ungrounded generation, since
  // there's no single archetype to calibrate the ask against.
  requestedDifficulty?: DifficultyLevel;
}): string {
  const {
    subjectName,
    boardName,
    gradeName,
    medium,
    responseLanguage = medium,
    chapter,
    topic,
    count,
    archetypes = [],
    requestedDifficulty,
  } = params;

  const difficultyAsk =
    requestedDifficulty && archetypes.length === 1 ? `\n\n${describeDifficultyAsk(archetypes[0], requestedDifficulty)}` : "";

  const taskInstruction =
    archetypes.length > 0
      ? `Generate exactly ${count} practice questions by instantiating the reasoning patterns below with FRESH numbers, names, and context of your own choosing -- never reuse or lightly reword a historical question, only the underlying reasoning structure. Cycle through the patterns (repeat some if there are fewer than ${count}) so the set as a whole reflects the mix of patterns and difficulty this chapter/topic actually gets tested on, not an arbitrary spread:

${archetypes.map(describeArchetype).join("\n")}${difficultyAsk}`
      : `Generate exactly ${count} practice questions appropriate for this grade, board, and topic, each with a complete worked solution. Vary the difficulty slightly across the ${count} questions.`;

  return `You are writing practice exercises for a ${gradeName} student studying ${subjectName} under the ${boardName} curriculum.

Chapter: "${chapter}"
Topic: "${topic}"

Write ONLY in ${responseLanguage}, regardless of what language this prompt is in. ${taskInstruction}

${archetypes.length > 0 ? EXERCISE_FORMAT_INSTRUCTIONS_WITH_PATTERN : EXERCISE_FORMAT_INSTRUCTIONS}`;
}

// Used only by questionRewrite.ts, immediately before a chat Q&A pair is
// written to the shared, cross-student answer bank -- never shown to the
// student, and never affects the reply they already received (this runs
// after the reply is sent, in the background). A student's typed question
// can legitimately be a verbatim copy of something from a copyrighted guide
// book or workbook (typed out, or pasted on desktop) -- answering it live is
// fine (the same grounding rules as any other reply already apply), but
// writing that exact copied text into a table every other student's queries
// can match against is a different, durable kind of copy. This restates the
// question in the model's own words -- keeping every fact, number, and the
// specific thing being asked (none of that is copyrightable on its own, and
// losing it would break legitimate exact-problem reuse) while dropping any
// narrative/passage framing the student may have copied along with it (a
// "read the following passage" style wrapper, decorative word-problem prose,
// etc.) -- the same paraphrase-not-reproduce principle
// buildTutorSystemPrompt's rule 6 already applies to answers, just applied
// to the question side of the pair for the first time here.
export function buildQuestionRestatementPrompt(): string {
  return `Restate the student's question in your own words, for storage in a database other students' similar questions will be matched against.

Rules:
1. Preserve every fact, number, equation, and the specific thing being asked -- these are not what this exists to remove, and losing them would make the stored question useless for finding this exact problem again.
2. Remove any narrative or passage-style wrapper text the student may have copied from a book alongside the actual question (a "read the following passage and answer" framing, decorative story text around a word problem, an exercise's own numbering or instructions) -- keep only the actual question being asked, in your own phrasing.
3. Keep it concise -- one to three sentences, no preamble, no explanation, no answer. Output ONLY the restated question, nothing else.`;
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
5. ${TABLE_FORMAT_RULE}

Keep responses focused and appropriately concise for a chat interface.`;
}

// Grades a student's own attempt at a practice exercise -- submitted
// BEFORE they've seen the worked solution (see topic-summary-message.tsx),
// so this is a real judgment call, not string comparison: a correct
// answer can legitimately be phrased, worked, or rounded differently than
// the stored solution. An LLM judge, not exact matching, is required for
// that reason -- see exerciseGrading.ts's own comment on why nothing
// simpler works for open-ended math/science responses.
export function buildGradingPrompt(params: {
  subjectName: string;
  medium: Medium;
  responseLanguage?: Medium;
  question: string;
  expectedAnswer: string;
  studentAnswer: string;
}): string {
  const { subjectName, medium, responseLanguage = medium, question, expectedAnswer, studentAnswer } = params;

  return `You are grading one student's own attempt at a ${subjectName} practice question, before showing them the worked solution.

QUESTION
${question}

EXPECTED SOLUTION (the student has NOT seen this)
${expectedAnswer}

STUDENT'S OWN ANSWER
${studentAnswer}

TASK
Judge whether the student's answer is correct -- based on whether their final result and reasoning are sound, NOT on whether their wording, method, or level of detail matches the expected solution exactly. A different valid method that reaches the same correct result is CORRECT. A right final answer reached through clearly flawed or missing reasoning, where the question calls for shown work, is PARTIALLY_CORRECT at best. An empty, off-topic, or clearly wrong answer is INCORRECT.

Write your feedback ONLY in ${responseLanguage}, regardless of what language this prompt is in -- 1-2 short sentences, encouraging in tone, pointing at the specific thing that was right or wrong (not a generic "good job" or "try again"). Do not restate or reveal the full expected solution in your feedback -- the student will see it separately right after this.

OUTPUT
Return ONLY, in exactly this format, no markdown, no other text:
Verdict: correct | partially_correct | incorrect
Feedback: <your feedback>`;
}
