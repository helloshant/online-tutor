import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isStaff } from "@/lib/auth";
import { resolveStudentSubjectScope } from "@/lib/studentScope";
import { resolveStaffPreviewScope } from "@/lib/staffPreview";

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
// given subject -- or, when topicId is also given, only tags actually
// present among that specific topic's entries (used to offer "refine by
// tag" chips under a topic's Relevant Exercises, and by the Practice
// panel's topic-scoped tag suggestions) -- so a tag search/filter box can
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

  const url = new URL(request.url);
  const subjectId = url.searchParams.get("subjectId");
  const topicId = url.searchParams.get("topicId")?.trim() || null;
  if (!subjectId) {
    return NextResponse.json({ error: "subjectId is required" }, { status: 400 });
  }

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  const staffPreview = isStaff(profile?.role)
    ? await resolveStaffPreviewScope(supabase, subjectId, {
        boardId: url.searchParams.get("boardId"),
        gradeId: url.searchParams.get("gradeId"),
        medium: url.searchParams.get("medium"),
      })
    : null;

  const scope = await resolveStudentSubjectScope(supabase, user.id, subjectId, staffPreview);
  if (!scope) {
    return NextResponse.json({ error: "That subject is not part of your subscription" }, { status: 403 });
  }

  // answered_questions has zero client-facing RLS policies (see
  // supabase/migrations/0005_answer_bank.sql) -- reachable only through the
  // service-role client, same as every other read of this table.
  const admin = createAdminClient();
  let query = admin
    .from("answered_questions")
    .select("tags")
    .eq("board_id", scope.boardId)
    .eq("grade_id", scope.gradeId)
    .eq("subject_id", subjectId)
    .eq("medium", scope.medium)
    .in("validation_status", ["auto_approved", "admin_approved"]);

  if (topicId) query = query.eq("topic_id", topicId);

  const { data } = await query;
  const tags = Array.from(new Set((data ?? []).flatMap((row) => row.tags))).sort();
  return NextResponse.json({ tags });
}
