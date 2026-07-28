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
      medium: Medium;
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

export type ChatOrchestrationSource = "cache" | "database" | "llm" | "rejected";

export type ChatOrchestrationResponse = {
  reply: string;
  source?: ChatOrchestrationSource;
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
  chapter: string;
  topic: string;
};

export type TopicSummaryResponse = {
  summary: string;
  source: "database" | "llm";
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
  chapter: string;
  topic: string;
};

export type ExerciseItem = { question: string; answer: string };

export type TopicExercisesResponse = {
  exercises: ExerciseItem[];
  source: "database" | "llm";
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
