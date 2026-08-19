import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveStudentSubjectScope } from "@/lib/studentScope";
import { searchChapterNotes } from "@/lib/orchestratorClient";

// Every code path below must return through NextResponse.json -- this
// top-level catch is the backstop so an unexpected throw never reaches the
// client as an empty/non-JSON body. Same pattern as /api/answer-bank/search
// and /api/chat.
export async function GET(request: Request) {
  try {
    return await handleSearch(request);
  } catch (err) {
    console.error("Unexpected error in GET /api/chapter-notes/search:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

// Student-facing semantic search over admin-authored chapter notes (the
// Practice panel's "Search chapter notes" feature) -- scoped to exactly the
// board/grade/medium a student's active subscription entitles them to for
// the requested subject, resolved server-side the same way
// /api/answer-bank/search does, never trusted from the client: chapter_
// document_chunks has zero client-facing RLS policies (see
// 0024_chapter_documents_rag.sql), so nothing stops a crafted request from
// asking for a board/grade this student never subscribed to if the scope
// weren't independently verified here.
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
  const query = url.searchParams.get("q")?.trim() || "";
  if (!subjectId || !query) {
    return NextResponse.json({ error: "subjectId and q are required" }, { status: 400 });
  }

  const scope = await resolveStudentSubjectScope(supabase, user.id, subjectId);
  if (!scope) {
    return NextResponse.json({ error: "That subject is not part of your subscription" }, { status: 403 });
  }

  try {
    const { results } = await searchChapterNotes({
      boardId: scope.boardId,
      gradeId: scope.gradeId,
      subjectId,
      medium: scope.medium,
      query,
    });
    return NextResponse.json({ results });
  } catch (err) {
    console.error("Chapter notes search failed:", err);
    return NextResponse.json({ error: "Could not search chapter notes right now." }, { status: 502 });
  }
}
