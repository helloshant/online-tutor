export type Medium = "English" | "Hindi" | "Bengali";
export type ChatTurn = { role: "user" | "assistant"; content: string };
export type SyllabusTopic = { chapter: string; topic: string };

// What the web app sends. `mode: "student"` requires board/grade/medium/
// topics (the full, unfiltered syllabus for that board+grade+subject --
// filtering to what's relevant happens in here, not in the caller).
// `mode: "staff"` is deliberately unrestricted: no board/grade/syllabus.
export type ChatOrchestrationRequest =
  | {
      mode: "student";
      subjectId: string;
      subjectName: string;
      boardId: string;
      boardName: string;
      gradeId: string;
      gradeName: string;
      medium: Medium;
      topics: SyllabusTopic[];
      message: string;
      history: ChatTurn[];
    }
  | {
      mode: "staff";
      subjectName: string;
      message: string;
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
export type AnswerScope = {
  boardId: string;
  gradeId: string;
  subjectId: string;
  medium: Medium;
  question: string;
};
