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
      subjectName: string;
      boardName: string;
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

export type ChatOrchestrationResponse = {
  reply: string;
};
