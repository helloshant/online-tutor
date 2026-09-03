export type Medium = "English" | "Hindi" | "Bengali";
export type ChatTurn = { role: "user" | "assistant"; content: string };
export type SyllabusTopic = { chapter: string; topic: string };

// Matches Anthropic's Base64ImageSource media_type union exactly, so no
// runtime cast is needed when building the content block.
export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
export type ImageAttachment = { mediaType: ImageMediaType; base64: string };

// What the web app sends. `mode: "student"` requires board/grade/medium/
// topics (the full, unfiltered syllabus for that board+grade+subject --
// filtering to what's relevant happens in here, not in the caller).
// `mode: "staff"` is deliberately unrestricted: no board/grade/syllabus.
// `image` is optional in both modes -- a screenshot/photo of a problem,
// read directly by the vision-capable model rather than run through a
// separate OCR step (see server.ts for why this also means skipping the
// cache/answer-bank stages).
export type ChatOrchestrationRequest =
  | {
      mode: "student";
      userId: string;
      subjectId: string;
      subjectName: string;
      boardId: string;
      boardName: string;
      gradeId: string;
      gradeName: string;
      // The student's real subscribed medium -- drives topic scope, the
      // syllabus gate, RAG retrieval, and the cache key. Never the language
      // toggle's value; see responseLanguage below and server.ts's own
      // comment for why conflating the two broke on a story that only
      // exists in one medium.
      medium: Medium;
      // Defaults to `medium` when omitted (a caller that predates this
      // field, or staff mode has no equivalent) -- only ever changes the
      // system prompt's language instruction, nothing about scope.
      responseLanguage?: Medium;
      topics: SyllabusTopic[];
      message: string;
      image?: ImageAttachment | null;
      history: ChatTurn[];
    }
  | {
      mode: "staff";
      userId: string;
      subjectId: string;
      subjectName: string;
      message: string;
      image?: ImageAttachment | null;
      history: ChatTurn[];
    };

// "chapter_notes" only ever appears on a topic-summary event (this union is
// shared with recordChatEvent's payload, see observabilityClient.ts) -- an
// ordinary chat reply never has admin-authored chapter content as its
// *whole* answer the way a topic summary can, only as retrieved context
// augmenting an LLM call (see chapterRag.ts), which still reports as "llm".
export type ChatOrchestrationSource = "cache" | "database" | "llm" | "rejected" | "chapter_notes";

export type ChatOrchestrationResponse = {
  reply: string;
  source?: ChatOrchestrationSource;
  // Best-guess {chapter, topic} this reply is about (see syllabusFilter.ts's
  // bestMatchingTopic) -- powers the "Practice a specific pattern" picker
  // on an ordinary chat reply, not just a topic-summary bubble (which
  // already knows its own topic statically, no guess needed). Only ever
  // set for mode:"student", never "rejected" (out of syllabus scope, no
  // topic to practice), and null when no topic scored above zero shared
  // keywords with the question -- an unconfident guess is worse than no
  // picker, not better. These are the SAME {chapter, topic} strings from
  // the caller's own `topics` array (ChatOrchestrationRequest), never
  // reworded/generated -- the web app can match them back to a real
  // syllabus_topics row by exact string equality, no fuzzy matching
  // needed, since it's the same source data round-tripped.
  matchedTopic?: { chapter: string; topic: string } | null;
};

// Identifies a single question within the L1 (Redis) / L2 (Postgres answer
// bank) lookup scope. Two students asking the same words under different
// boards/grades/mediums must never share an answer.
//
// topicId is optional and only ever set by the topic-exercises generation
// flow -- an ordinary chat question has no syllabus topic concept, only a
// board/grade/subject/medium scope. When set, it's what search_topic_exercises
// matches on exactly, rather than the fuzzy chapter+topic text ranking this
// replaced (see 0015_answer_bank_topic_id.sql).
export type AnswerScope = {
  boardId: string;
  gradeId: string;
  subjectId: string;
  medium: Medium;
  question: string;
  topicId?: string;
};

export type TopicSummaryRequest = {
  userId: string;
  topicId: string;
  subjectId: string;
  subjectName: string;
  boardName: string;
  gradeName: string;
  medium: Medium;
  // See ChatOrchestrationRequest's own comment -- defaults to `medium`.
  responseLanguage?: Medium;
  chapter: string;
  topic: string;
};

export type TopicSummaryResponse = {
  summary: string;
  source: "chapter_notes" | "cache" | "database" | "llm";
};

export type TopicExercisesRequest = {
  userId: string;
  topicId: string;
  boardId: string;
  gradeId: string;
  subjectId: string;
  subjectName: string;
  boardName: string;
  gradeName: string;
  medium: Medium;
  // See ChatOrchestrationRequest's own comment -- defaults to `medium`.
  responseLanguage?: Medium;
  chapter: string;
  topic: string;
};

// id is the answered_questions row id -- every exercise returned to a
// student (whether freshly generated or reused from the bank, see
// server.ts's own topic-exercises handler) is a real stored row by the
// time it's returned, so this is never optional. archetypeRunId/
// archetypeId are set only when this specific exercise was generated
// from (or matched to) a mined archetype -- see archetypeExercises.ts --
// and are what /v1/topic-exercises/grade uses to credit
// student_archetype_progress on a graded attempt.
export type ExerciseItem = {
  id: string;
  question: string;
  answer: string;
  archetypeRunId?: string | null;
  archetypeId?: string | null;
};

export type TopicExercisesResponse = {
  exercises: ExerciseItem[];
  source: "database" | "llm";
};

// One curated, real exam pattern this exact chapter/topic has mined
// archetypes for -- powers the on-demand "practice a specific pattern"
// picker under Relevant Exercises (Tier C). Deliberately narrower than
// archetypeExercises.ts's own ExerciseArchetype: no
// invariantReasoningStructure/variationDescriptions, since those are
// generation-prompt inputs, not meant for display to a student. runId is
// carried through (never shown) because archetypeId is only unique
// WITHIN a run -- /v1/topic-exercises/generate needs both back to
// identify which pattern was actually picked.
export type DifficultyLevel = "Easy" | "Medium" | "Hard";

export type TopicPattern = {
  runId: string;
  archetypeId: string;
  name: string;
  // Dominant historical difficulty -- kept for a compact display, e.g.
  // "usually Hard." difficultyDistribution below is the full spread
  // behind it (Tier D: shown as a hint next to the Easy/Medium/Hard
  // picker, e.g. "7 of 10 mined Hard, 3 Medium, 0 Easy"), so a student
  // asking for a level this pattern rarely/never appears at can see that
  // up front, before generation has to calibrate around it server-side
  // (see prompts.ts's describeDifficultyAsk).
  difficulty: DifficultyLevel | null;
  difficultyDistribution: Record<DifficultyLevel, number> | null;
  // Sorted ascending years this pattern actually appeared in real exams,
  // e.g. [2025, 2026] -- suffixed onto the pattern's own name in the
  // picker (e.g. "Determine Relation Properties (2025, 2026)") so a
  // student can see which real exam years actually tested this before
  // picking it, not just its name. Empty when Stage 1 never classified a
  // year for any of the archetype's supporting questions -- the picker
  // just shows the bare name then, no empty "()" suffix.
  yearsObserved: number[];
};

export type TopicPatternsRequest = {
  boardName: string;
  gradeName: string;
  subjectName: string;
  chapter: string;
  topic: string;
};

export type TopicPatternsResponse = {
  patterns: TopicPattern[];
};

// On-demand generation for ONE specific pattern the student picked (both
// archetypeId and archetypeRunId set, matching a TopicPattern from
// /v1/topic-exercises/patterns), or a random one from whatever's mined
// for this topic (both omitted -- "Generate another"). Deliberately
// skips the answer-bank lookup /v1/topic-exercises does first: the whole
// point of this endpoint is a fresh question, not whatever's already
// banked for this topic.
export type GenerateTopicExerciseRequest = TopicExercisesRequest & {
  archetypeId?: string;
  archetypeRunId?: string;
  // Tier D: set only when the student picked a specific level rather than
  // "Any difficulty" -- see prompts.ts's describeDifficultyAsk for how
  // this gets calibrated against the pattern's own real
  // difficultyDistribution rather than trusted to just work.
  requestedDifficulty?: DifficultyLevel;
};

export type GenerateTopicExerciseResponse = {
  // null only when nothing's mined for this topic at all, or generation/
  // storage genuinely failed -- never an error response, since the
  // picker itself simply wouldn't have shown anything to click in the
  // first case, and a transient generation failure is the caller's to
  // retry, not to treat as a hard error.
  exercise: ExerciseItem | null;
};

// A student's own attempt at one exercise, submitted BEFORE they've seen
// the worked solution (see topic-summary-message.tsx) -- graded by an LLM
// judge (buildGradingPrompt in prompts.ts), not exact-string matching,
// since a correct answer can legitimately be phrased or worked many ways.
// Deliberately carries no medium/language field -- the exercise's own
// stored answered_questions.medium already IS the exact language it was
// generated/shown in (see TopicExercisesRequest's own comment: "scope's
// own medium is deliberately responseLanguage"), so grading feedback just
// reuses that directly (see getExerciseForGrading) rather than trusting
// the caller to resupply it consistently.
export type GradeExerciseRequest = {
  userId: string;
  exerciseId: string;
  studentAnswer: string;
};

export type ExerciseVerdict = "correct" | "partially_correct" | "incorrect";

export type GradeExerciseResponse = {
  verdict: ExerciseVerdict;
  feedback: string;
  // The worked solution -- withheld from the student until now (see
  // GradeExerciseRequest's own comment), so the grading response is what
  // finally reveals it, regardless of the verdict.
  answer: string;
};

// Sent by the web app's admin Chapter Notes action right after it writes/
// updates a chapter_documents row (this service never touches that table
// directly -- see chapterDocuments.ts). scope mirrors AnswerScope minus
// `question`/`topicId`'s optionality, since a chapter document is always
// tied to exactly one topic, unlike an ordinary chat question.
export type ChapterDocumentEmbedRequest = {
  documentId: string;
  topicId: string;
  boardId: string;
  gradeId: string;
  subjectId: string;
  medium: Medium;
  content: string;
};

// Shared by both the naive paste-and-chunk endpoint above and the
// pre-chunked import endpoint below -- both ultimately just report how many
// chunks landed and whether embedding itself succeeded.
export type ChapterDocumentEmbedResponse = {
  chunkCount: number;
  // false only when embedding itself failed (e.g. Voyage unreachable or
  // VOYAGE_API_KEY unset) -- the caller still keeps the chapter_documents
  // row either way (the raw text is never lost), this just tells it
  // whether retrieval will actually find anything for that row yet.
  embedded: boolean;
};

// Sibling of ChapterDocumentEmbedRequest for the pre-chunked JSON import
// path (see chapterDocuments.ts's embedAndStorePrechunkedDocument) --
// `chunks` arrive already split by whoever prepared the JSON, each with its
// own optional fieldType/citation, so this skips chunkText() entirely
// rather than re-splitting already-correct pieces.
export type ChapterDocumentImportChunksRequest = {
  documentId: string;
  topicId: string;
  boardId: string;
  gradeId: string;
  subjectId: string;
  medium: Medium;
  chunks: { content: string; fieldType?: string; citation?: string }[];
};

export type TokenUsage = { promptTokens: number; completionTokens: number };

// What an LLM provider returns -- the model field echoes back the exact
// model/deployment that served the request (not just what was configured),
// since that's what determines the cost calculation in the observability
// service.
export type LlmReply = {
  text: string;
  model: string;
  usage: TokenUsage;
};
