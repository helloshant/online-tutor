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

// Lookup into the answer bank by tag, topic, or both together -- e.g. "show
// me exercises from Ganit Prakash," "relevant exercises for this topic," or
// "Ganit Prakash exercises for this topic" (the combined case: distinct
// from /api/topics/[id]/exercises, which is topic-only and generates fresh
// exercises via the LLM on a miss -- this endpoint is read-only over
// whatever's already tagged/topic-scoped in the bank, and never generates).
// At least one of tag/topicId is required -- neither would mean "everything
// ever banked for this subject," an unbounded dump with no real use case
// here.
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
  const tag = url.searchParams.get("tag")?.trim() || null;
  const topicId = url.searchParams.get("topicId")?.trim() || null;
  if (!subjectId || (!tag && !topicId)) {
    return NextResponse.json({ error: "subjectId and at least one of tag/topicId are required" }, { status: 400 });
  }

  const scope = await resolveStudentSubjectScope(supabase, user.id, subjectId);
  if (!scope) {
    return NextResponse.json({ error: "That subject is not part of your subscription" }, { status: 403 });
  }

  const admin = createAdminClient();
  let query = admin
    .from("answered_questions")
    .select("question, answer")
    .eq("board_id", scope.boardId)
    .eq("grade_id", scope.gradeId)
    .eq("subject_id", subjectId)
    .eq("medium", scope.medium)
    .in("validation_status", ["auto_approved", "admin_approved"])
    .order("created_at", { ascending: true })
    .limit(SEARCH_LIMIT);

  if (topicId) query = query.eq("topic_id", topicId);
  if (tag) query = query.contains("tags", [tag]);

  const { data } = await query;
  return NextResponse.json({ results: data ?? [] });
}
