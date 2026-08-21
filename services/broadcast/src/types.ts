export type Medium = "English" | "Hindi" | "Bengali";

// Sent by the web app's admin "Send" action right after it creates a draft
// broadcast (a plain insert the web app does itself via its own admin
// client -- see the Dockerfile's own comment on why that split exists).
// Every targeting field left undefined/null means "no filter on this
// dimension" -- see audience.ts.
export type SendBroadcastRequest = {
  broadcastId: string;
  boardId: string | null;
  gradeId: string | null;
  subjectId: string | null;
  medium: Medium | null;
};

export type SendBroadcastResponse = {
  recipientCount: number;
};

export type SubmittedAnswer = {
  questionId: string;
  selectedOption?: number;
  answerText?: string;
};

// Sent by the web app's POST /api/broadcasts/[id]/test/submit proxy route
// after it's confirmed (via the student's own session) that userId really
// is the caller and that they're a recipient of this broadcast -- this
// service re-verifies the attempt itself rather than trusting that check,
// since it's the actual trust boundary for what score gets recorded.
export type SubmitTestRequest = {
  broadcastId: string;
  userId: string;
  answers: SubmittedAnswer[];
};

export type SubmitTestResponse = {
  attemptId: string;
  status: "submitted" | "graded";
  totalScore: number;
  maxPossibleScore: number;
};

// Sent by the admin test-results page when grading a short_answer response.
export type GradeAnswerRequest = {
  answerId: string;
  score: number;
};

export type GradeAnswerResponse = {
  attemptId: string;
  attemptStatus: "submitted" | "graded";
  totalScore: number;
  maxPossibleScore: number;
};
