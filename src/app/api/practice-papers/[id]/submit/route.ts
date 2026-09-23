import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { evaluatePracticePaperSubmission } from "@/lib/orchestratorClient";
import type { ImageMediaType } from "@/lib/orchestratorClient";

const BUCKET = "practice-answer-sheets";
// Same allow-list as /api/chat's own image handling -- a photographed
// answer sheet is the same kind of upload (a phone camera photo), not a
// scanned document/PDF the way an admin-authored exam paper can be.
const ALLOWED_IMAGE_TYPES = new Set<ImageMediaType>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
// Reuses exam/submit's own per-file cap.
const MAX_FILE_BYTES = 15 * 1024 * 1024;
// Kept in sync by hand with the orchestrator's own
// server.ts:MAX_IMAGES_PER_SUBMISSION.
const MAX_IMAGES_PER_SUBMISSION = 4;
// Reuses /api/chat's own base64 cap (~4.3MB decoded) -- the orchestrator
// re-validates this too, but rejecting an oversized image here means the
// upload/base64-encode work already done for it isn't wasted on a request
// that was always going to be rejected downstream.
const MAX_IMAGE_BASE64_LENGTH = 6_000_000;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    return await handlePost(request, await params);
  } catch (err) {
    console.error(
      "Unexpected error in POST /api/practice-papers/[id]/submit:",
      err,
    );
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
}

// Uploads the student's photographed answer sheet, then immediately
// grades it synchronously (no queue/worker infra exists in this codebase
// -- see the accompanying plan). A slow or failed grading call leaves the
// submission in 'failed' with its files already kept, so a student can
// retry without re-uploading (see the client's own retry, which re-POSTs
// the same in-memory files).
async function handlePost(request: Request, { id: paperId }: { id: string }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: paper } = await admin
    .from("practice_papers")
    .select("id, user_id, board_id, grade_id, subject_id, medium, total_marks")
    .eq("id", paperId)
    .maybeSingle();
  if (!paper) {
    return NextResponse.json(
      { error: "Practice paper not found" },
      { status: 404 },
    );
  }
  if (paper.user_id !== user.id) {
    return NextResponse.json(
      { error: "This isn't your practice paper." },
      { status: 403 },
    );
  }

  const { data: existing } = await admin
    .from("practice_paper_submissions")
    .select("id, status")
    .eq("paper_id", paperId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (existing?.status === "graded") {
    return NextResponse.json(
      { error: "This has already been graded and can't be resubmitted." },
      { status: 400 },
    );
  }

  const { data: questionRows } = await admin
    .from("practice_paper_questions")
    .select("id, answered_question_id, question_type, marks")
    .eq("paper_id", paperId);
  if (!questionRows || questionRows.length === 0) {
    return NextResponse.json(
      { error: "This practice paper has no questions to grade." },
      { status: 400 },
    );
  }

  const formData = await request.formData();
  const files = formData
    .getAll("files")
    .filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) {
    return NextResponse.json(
      { error: "Upload at least one photo." },
      { status: 400 },
    );
  }
  if (files.length > MAX_IMAGES_PER_SUBMISSION) {
    return NextResponse.json(
      { error: `Upload at most ${MAX_IMAGES_PER_SUBMISSION} photos.` },
      { status: 400 },
    );
  }

  const images: { mediaType: ImageMediaType; base64: string }[] = [];
  const paths: string[] = [];
  for (const file of files) {
    if (
      file.size > MAX_FILE_BYTES ||
      !ALLOWED_IMAGE_TYPES.has(file.type as ImageMediaType)
    ) {
      return NextResponse.json(
        {
          error: `${file.name || "A photo"} isn't a supported type/size (JPEG, PNG, GIF, or WebP, up to 15MB).`,
        },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const base64 = buffer.toString("base64");
    if (base64.length > MAX_IMAGE_BASE64_LENGTH) {
      return NextResponse.json(
        {
          error: `${file.name || "A photo"} is too large. Please attach something under ~4MB.`,
        },
        { status: 400 },
      );
    }

    const path = `${paperId}/${user.id}-${crypto.randomUUID()}`;
    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(path, buffer, { contentType: file.type });
    if (uploadError) {
      console.error("Practice-paper answer sheet upload failed:", uploadError);
      return NextResponse.json(
        { error: "Could not upload your answer sheet. Please try again." },
        { status: 500 },
      );
    }
    paths.push(path);
    images.push({ mediaType: file.type as ImageMediaType, base64 });
  }

  const { data: submission, error: upsertError } = await admin
    .from("practice_paper_submissions")
    .upsert(
      {
        paper_id: paperId,
        user_id: user.id,
        file_paths: paths,
        status: "grading",
        submitted_at: new Date().toISOString(),
        total_score: null,
        max_possible_score: null,
        overall_feedback: null,
        graded_at: null,
      },
      { onConflict: "paper_id,user_id" },
    )
    .select("id")
    .single();
  if (upsertError || !submission) {
    console.error("Failed to record practice-paper submission:", upsertError);
    return NextResponse.json(
      { error: "Could not save your submission. Please try again." },
      { status: 500 },
    );
  }

  const { data: subject } = await admin
    .from("subjects")
    .select("name")
    .eq("id", paper.subject_id)
    .single();

  try {
    const { results, totalScore, overallFeedback } =
      await evaluatePracticePaperSubmission({
        userId: user.id,
        // Re-resolved from the paper's own stored row, never trusted from
        // the request -- same reasoning as every other trust boundary in
        // this app.
        subjectId: paper.subject_id,
        boardId: paper.board_id,
        gradeId: paper.grade_id,
        subjectName: subject?.name ?? "",
        medium: paper.medium,
        questions: questionRows.map((q) => ({
          id: q.id,
          answeredQuestionId: q.answered_question_id,
          type: q.question_type,
          marks: q.marks,
        })),
        images,
      });

    const { error: scoresError } = await admin
      .from("practice_paper_question_scores")
      .upsert(
        results.map((r) => ({
          submission_id: submission.id,
          question_id: r.id,
          score: r.score,
          feedback: r.feedback,
        })),
        { onConflict: "submission_id,question_id" },
      );
    if (scoresError) {
      throw new Error(
        `Failed to store question scores: ${scoresError.message}`,
      );
    }

    const { error: gradedError } = await admin
      .from("practice_paper_submissions")
      .update({
        status: "graded",
        total_score: totalScore,
        max_possible_score: paper.total_marks,
        overall_feedback: overallFeedback,
        graded_at: new Date().toISOString(),
      })
      .eq("id", submission.id);
    if (gradedError) {
      throw new Error(
        `Failed to mark submission graded: ${gradedError.message}`,
      );
    }

    return NextResponse.json({
      submission: {
        id: submission.id,
        status: "graded",
        totalScore,
        maxPossibleScore: paper.total_marks,
        overallFeedback,
      },
      results,
    });
  } catch (err) {
    console.error("Practice-paper grading failed:", err);
    await admin
      .from("practice_paper_submissions")
      .update({ status: "failed" })
      .eq("id", submission.id);
    return NextResponse.json(
      {
        error:
          "Could not grade this submission right now. Your photos were saved -- please try again shortly.",
      },
      { status: 502 },
    );
  }
}

// Vision grading of a multi-image submission can take a while.
export const maxDuration = 60;
