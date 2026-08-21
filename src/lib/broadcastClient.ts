import "server-only";

// Only the two operations services/broadcast actually owns: resolving who
// a broadcast's board/grade/subject/medium filter reaches (and fanning
// that out into broadcast_recipients), and scoring a submitted test.
// Everything else about a broadcast -- drafting, listing, reading an
// inbox, submitting feedback -- this app does itself directly against
// Supabase via its own admin client, the same split paymentClient.ts uses
// for coupon generation/redemption vs. plain coupon listing.
import type { Medium } from "@/lib/supabase/types";

function getBroadcastUrl(): string {
  const url = process.env.BROADCAST_URL;
  if (!url) throw new Error("Missing BROADCAST_URL environment variable");
  return url;
}

async function callBroadcastService<T>(path: string, body: unknown): Promise<T> {
  const url = `${getBroadcastUrl().replace(/\/$/, "")}${path}`;
  const sharedSecret = process.env.BROADCAST_SHARED_SECRET;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sharedSecret ? { "x-internal-api-key": sharedSecret } : {}),
    },
    body: JSON.stringify(body),
  });

  const responseBody = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(responseBody?.error ?? `Broadcast service request failed with status ${res.status}`);
  }
  return responseBody as T;
}

export async function sendBroadcast(
  broadcastId: string,
  scope: { boardId: string | null; gradeId: string | null; subjectId: string | null; medium: Medium | null }
): Promise<{ recipientCount: number }> {
  return callBroadcastService<{ recipientCount: number }>(`/v1/broadcasts/${broadcastId}/send`, scope);
}

export type SubmittedAnswer = { questionId: string; selectedOption?: number; answerText?: string };

export async function submitTest(
  broadcastId: string,
  userId: string,
  answers: SubmittedAnswer[]
): Promise<{ attemptId: string; status: "submitted" | "graded"; totalScore: number; maxPossibleScore: number }> {
  return callBroadcastService(`/v1/broadcasts/${broadcastId}/test/submit`, { userId, answers });
}

export async function gradeTestAnswer(
  answerId: string,
  score: number
): Promise<{ attemptId: string; attemptStatus: "submitted" | "graded"; totalScore: number; maxPossibleScore: number }> {
  return callBroadcastService(`/v1/test-answers/${answerId}/grade`, { score });
}
