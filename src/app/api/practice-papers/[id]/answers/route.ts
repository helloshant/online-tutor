import { NextResponse } from "next/server";
import { isStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

// Staff-only: reveals the already-generated answer for every question in a
// practice paper, so an admin/superadmin can review or export an answer
// key. A real student never gets this -- the answer is never surfaced to
// the ordinary submit/grade flow as text, only used internally to grade a
// photographed answer sheet (see /[id]/submit/route.ts).
//
// Same "regular session client, not admin" posture as GET /[id] -- this
// relies on TWO RLS layers for free: practice_papers' own "user can read
// own rows" policy (0048_practice_papers.sql) means a staff caller can
// only ever reach a paper they themselves generated, and
// answered_questions' "admin can read all" policy
// (0006_answer_bank_validation.sql) means a non-staff session couldn't
// read the answer text even if the isStaff() check below were somehow
// bypassed. The isStaff() check is still the primary, explicit gate (a
// hard 403, not just an empty result) since this is the one guarantee the
// feature explicitly asked for.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    return await handleGet(await params);
  } catch (err) {
    console.error(
      "Unexpected error in GET /api/practice-papers/[id]/answers:",
      err,
    );
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

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!isStaff(profile?.role)) {
    return NextResponse.json(
      { error: "Only admins and superadmins can view answers." },
      { status: 403 },
    );
  }

  const { data: paper } = await supabase
    .from("practice_papers")
    .select("id")
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
    .select("id, answered_question_id")
    .eq("paper_id", paperId);

  const answeredIds = (questionRows ?? []).map((q) => q.answered_question_id);
  const { data: answeredRows } = answeredIds.length
    ? await supabase
        .from("answered_questions")
        .select("id, answer")
        .in("id", answeredIds)
    : { data: [] };
  const answerByAnsweredId = new Map(
    (answeredRows ?? []).map((a) => [a.id, a.answer]),
  );

  return NextResponse.json({
    answers: (questionRows ?? []).map((q) => ({
      questionId: q.id,
      answer: answerByAnsweredId.get(q.answered_question_id) ?? "",
    })),
  });
}
