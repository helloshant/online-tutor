import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveStudentSubjectScope } from "@/lib/studentScope";

const SEARCH_LIMIT = 20;

// Every code path below must return through NextResponse.json -- this
// top-level catch is the backstop so an unexpected throw never reaches the
// client as an empty/non-JSON body. Same pattern as /api/chat.
export async function GET(request: Request) {
  try {
    return await handleSearch(request);
  } catch (err) {
    console.error("Unexpected error in GET /api/answer-bank/search:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

// Tag-based lookup into the answer bank -- e.g. "show me exercises from
// Ganit Prakash" or "questions from WBJEE 2023" -- distinct from the
// topic-scoped "Relevant Exercises" flow (/api/topics/[id]/exercises),
// which matches on an exact syllabus topic_id rather than a tag. Only
// entries an admin has tagged (manually, or via bulk import) are reachable
// this way; LLM-generated chat/exercise entries have no tags unless an
// admin adds them.
async function handleSearch(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const url = new URL(request.url);
  const subjectId = url.searchParams.get("subjectId");
  const tag = url.searchParams.get("tag")?.trim();
  if (!subjectId || !tag) {
    return NextResponse.json({ error: "subjectId and tag are required" }, { status: 400 });
  }

  const scope = await resolveStudentSubjectScope(supabase, user.id, subjectId);
  if (!scope) {
    return NextResponse.json({ error: "That subject is not part of your subscription" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data } = await admin
    .from("answered_questions")
    .select("question, answer")
    .eq("board_id", scope.boardId)
    .eq("grade_id", scope.gradeId)
    .eq("subject_id", subjectId)
    .eq("medium", scope.medium)
    .contains("tags", [tag])
    .in("validation_status", ["auto_approved", "admin_approved"])
    .order("created_at", { ascending: true })
    .limit(SEARCH_LIMIT);

  return NextResponse.json({ results: data ?? [] });
}
