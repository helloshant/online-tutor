import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveStudentSubjectScope } from "@/lib/studentScope";

// Every code path below must return through NextResponse.json -- this
// top-level catch is the backstop so an unexpected throw never reaches the
// client as an empty/non-JSON body. Same pattern as /api/chat.
export async function GET(request: Request) {
  try {
    return await handleGetTags(request);
  } catch (err) {
    console.error("Unexpected error in GET /api/answer-bank/tags:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

// Distinct tags available within the student's board/grade/medium for a
// given subject, so the tag search box (dashboard/tag-search-panel.tsx) can
// suggest real values instead of asking the student to guess exact tag
// text like "Ganit Prakash" or "WBJEE 2023" blind.
async function handleGetTags(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const subjectId = new URL(request.url).searchParams.get("subjectId");
  if (!subjectId) {
    return NextResponse.json({ error: "subjectId is required" }, { status: 400 });
  }

  const scope = await resolveStudentSubjectScope(supabase, user.id, subjectId);
  if (!scope) {
    return NextResponse.json({ error: "That subject is not part of your subscription" }, { status: 403 });
  }

  // answered_questions has zero client-facing RLS policies (see
  // supabase/migrations/0005_answer_bank.sql) -- reachable only through the
  // service-role client, same as every other read of this table.
  const admin = createAdminClient();
  const { data } = await admin
    .from("answered_questions")
    .select("tags")
    .eq("board_id", scope.boardId)
    .eq("grade_id", scope.gradeId)
    .eq("subject_id", subjectId)
    .eq("medium", scope.medium)
    .in("validation_status", ["auto_approved", "admin_approved"]);

  const tags = Array.from(new Set((data ?? []).flatMap((row) => row.tags))).sort();
  return NextResponse.json({ tags });
}
