// Retrieval half of the RAG feature (see chapterDocuments.ts for the
// embed/store half and supabase/migrations/0024_chapter_documents_rag.sql
// for match_chapter_chunks). Called from server.ts's /v1/chat stage 4,
// right before the LLM call, so a chat reply can be grounded in real
// admin-authored chapter content instead of the LLM's own general
// knowledge -- unlike the answer bank's exact-question dedup, this is
// content *augmentation*, not a lookup that can short-circuit the LLM call.
import { getSupabaseClient } from "./supabaseClient.js";
import { embed } from "./voyageClient.js";
import type { AnswerScope } from "./types.js";

// Below this, a "match" shares too little meaning with the question to be
// worth quoting at the model -- an irrelevant excerpt is worse than none,
// since it can distract the model into answering the excerpt instead of the
// actual question. Similarity here is cosine similarity (see
// match_chapter_chunks), not ts_rank, so this isn't comparable to
// answerBank.ts's MIN_RANK despite the similar-looking threshold.
const MIN_SIMILARITY = 0.5;
const MATCH_COUNT = 4;

// Fails open at every step, same philosophy as findAnswerInBank -- a
// missing Supabase/Voyage connection or a query error just means the chat
// reply proceeds without retrieved context, never that the request fails.
export async function findRelevantChapterChunks(
  scope: Omit<AnswerScope, "question">,
  queryText: string
): Promise<string[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  const embeddings = await embed([queryText], "query");
  if (!embeddings || !embeddings[0]) return [];

  const { data, error } = await supabase.rpc("match_chapter_chunks", {
    p_board_id: scope.boardId,
    p_grade_id: scope.gradeId,
    p_subject_id: scope.subjectId,
    p_medium: scope.medium,
    p_query_embedding: embeddings[0],
    p_match_count: MATCH_COUNT,
  });

  if (error) {
    console.error("Chapter chunk retrieval failed:", error);
    return [];
  }

  return ((data ?? []) as { content: string; similarity: number }[])
    .filter((row) => row.similarity >= MIN_SIMILARITY)
    .map((row) => row.content);
}
