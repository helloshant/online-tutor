import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const EXAM_BUCKET = "exam-files";
const SIGNED_URL_TTL_SECONDS = 60 * 10;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await handleGet(await params);
  } catch (err) {
    console.error("Unexpected error in GET /api/broadcasts/[id]/exam:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

async function signPaths(admin: ReturnType<typeof createAdminClient>, paths: string[]): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map();
  const { data, error } = await admin.storage.from(EXAM_BUCKET).createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
  const result = new Map<string, string>();
  if (error || !data) return result;
  for (const d of data) {
    if (d.path && d.signedUrl) result.set(d.path, d.signedUrl);
  }
  return result;
}

async function handleGet({ id: broadcastId }: { id: string }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const admin = createAdminClient();

  const [{ data: recipient }, { data: broadcast }] = await Promise.all([
    admin.from("broadcast_recipients").select("id").eq("broadcast_id", broadcastId).eq("user_id", user.id).maybeSingle(),
    admin.from("broadcasts").select("type, attachment_paths").eq("id", broadcastId).maybeSingle(),
  ]);
  if (!recipient) {
    return NextResponse.json({ error: "This wasn't sent to you." }, { status: 403 });
  }
  if (!broadcast || broadcast.type !== "exam") {
    return NextResponse.json({ error: "This isn't an exam." }, { status: 400 });
  }

  const { data: questions } = await admin
    .from("exam_questions")
    .select("id, question, max_score, sort_order")
    .eq("broadcast_id", broadcastId)
    .order("sort_order");

  const { data: submission } = await admin
    .from("exam_submissions")
    .select("id, file_paths, status, total_score, max_possible_score, feedback, submitted_at")
    .eq("broadcast_id", broadcastId)
    .eq("user_id", user.id)
    .maybeSingle();

  // Per-question marks are only meaningful once the whole submission is
  // graded -- while it's still 'submitted', nothing has necessarily been
  // scored yet, so there's nothing useful to show per question.
  let questionScores: { question_id: string; score: number }[] = [];
  if (submission?.status === "graded") {
    const { data } = await admin
      .from("exam_question_scores")
      .select("question_id, score")
      .eq("submission_id", submission.id);
    questionScores = data ?? [];
  }

  const paperPaths = broadcast.attachment_paths ?? [];
  const submissionPaths = submission?.file_paths ?? [];
  const urlByPath = await signPaths(admin, [...paperPaths, ...submissionPaths]);

  return NextResponse.json({
    paperUrls: paperPaths.map((p) => urlByPath.get(p)).filter((u): u is string => Boolean(u)),
    questions: questions ?? [],
    submission: submission
      ? {
          id: submission.id,
          status: submission.status,
          totalScore: submission.total_score,
          maxPossibleScore: submission.max_possible_score,
          feedback: submission.feedback,
          submittedAt: submission.submitted_at,
          fileUrls: submissionPaths.map((p) => urlByPath.get(p)).filter((u): u is string => Boolean(u)),
        }
      : null,
    questionScores,
  });
}
