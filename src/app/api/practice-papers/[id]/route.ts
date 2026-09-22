import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// A pure read, relying entirely on the RLS "user can read own rows"
// policies on all four practice_paper_* tables (0048_practice_papers.sql)
// -- the regular session client, not the admin client, is what makes that
// meaningful: a request for someone else's paper id resolves to "not
// found" here, not a 403, since RLS makes the row simply not exist from
// this session's point of view.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    return await handleGet(await params);
  } catch (err) {
    console.error("Unexpected error in GET /api/practice-papers/[id]:", err);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
}

async function handleGet({ id: paperId }: { id: string }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: paper } = await supabase
    .from("practice_papers")
    .select("id, subject_id, chapters, total_marks, created_at")
    .eq("id", paperId)
    .maybeSingle();

  if (!paper) {
    return NextResponse.json(
      { error: "Practice paper not found" },
      { status: 404 },
    );
  }

  const { data: questionRows } = await supabase
    .from("practice_paper_questions")
    .select("id, answered_question_id, question_type, marks, sort_order")
    .eq("paper_id", paperId)
    .order("sort_order");

  const answeredIds = (questionRows ?? []).map((q) => q.answered_question_id);
  const { data: answeredRows } = answeredIds.length
    ? await supabase
        .from("answered_questions")
        .select("id, question")
        .in("id", answeredIds)
    : { data: [] };
  const questionTextById = new Map(
    (answeredRows ?? []).map((a) => [a.id, a.question]),
  );

  // At most one row -- unique(paper_id, user_id) plus RLS already scopes
  // this to the current student's own attempt, if any.
  const { data: submission } = await supabase
    .from("practice_paper_submissions")
    .select(
      "id, status, total_score, max_possible_score, overall_feedback, submitted_at, graded_at",
    )
    .eq("paper_id", paperId)
    .maybeSingle();

  let scoresByQuestionId = new Map<
    string,
    { score: number; feedback: string }
  >();
  if (submission) {
    const { data: scoreRows } = await supabase
      .from("practice_paper_question_scores")
      .select("question_id, score, feedback")
      .eq("submission_id", submission.id);
    scoresByQuestionId = new Map(
      (scoreRows ?? []).map((s) => [
        s.question_id,
        { score: s.score, feedback: s.feedback },
      ]),
    );
  }

  return NextResponse.json({
    paper: {
      id: paper.id,
      subjectId: paper.subject_id,
      chapters: paper.chapters,
      totalMarks: paper.total_marks,
      createdAt: paper.created_at,
      questions: (questionRows ?? []).map((q) => ({
        id: q.id,
        question: questionTextById.get(q.answered_question_id) ?? "",
        type: q.question_type,
        marks: q.marks,
        score: scoresByQuestionId.get(q.id)?.score ?? null,
        feedback: scoresByQuestionId.get(q.id)?.feedback ?? null,
      })),
    },
    submission: submission
      ? {
          id: submission.id,
          status: submission.status,
          totalScore: submission.total_score,
          maxPossibleScore: submission.max_possible_score,
          overallFeedback: submission.overall_feedback,
          submittedAt: submission.submitted_at,
          gradedAt: submission.graded_at,
        }
      : null,
  });
}
