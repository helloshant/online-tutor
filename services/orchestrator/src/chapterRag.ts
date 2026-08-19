// Retrieval half of the RAG feature (see chapterDocuments.ts for the
// embed/store half and supabase/migrations/0024_chapter_documents_rag.sql /
// 0025_chapter_notes_search.sql for match_chapter_chunks). Two different
// callers share the same underlying query:
//   - findRelevantChapterChunks: /v1/chat stage 4 (server.ts), right before
//     the LLM call, so a chat reply can be grounded in real admin-authored
//     chapter content instead of the LLM's own general knowledge. Content
//     augmentation, not a lookup that can short-circuit the LLM call.
//   - searchChapterNotes: the student-facing "Search chapter notes" feature
//     in the Practice panel -- a direct, read-only semantic search (no LLM
//     call at all), same "browse what's already there" philosophy as the
//     Practice panel's existing topic/tag search over the answer bank, just
//     matched by meaning instead of exact topic/tag.
import { getSupabaseClient } from "./supabaseClient.js";
import { embed } from "./voyageClient.js";
import type { AnswerScope, Medium } from "./types.js";

// Below this, a "match" shares too little meaning with the query to be
// worth surfacing -- for chat augmentation, an irrelevant excerpt can
// distract the model into answering the excerpt instead of the actual
// question; for student-facing search, it's just noise. Similarity here is
// cosine similarity (see match_chapter_chunks), not ts_rank, so this isn't
// comparable to answerBank.ts's MIN_RANK despite the similar-looking
// threshold.
const MIN_SIMILARITY = 0.5;

// Small for chat augmentation -- these get stitched straight into the
// system prompt, so more matches means more tokens on every LLM call.
// Larger for a dedicated search screen, where a student browsing chapter
// notes benefits from seeing more of what's actually banked.
const CHAT_MATCH_COUNT = 4;
const SEARCH_MATCH_COUNT = 10;

export type ChapterChunkMatch = {
  documentId: string;
  title: string;
  chapter: string;
  topic: string;
  content: string;
  similarity: number;
};

// Fails open at every step, same philosophy as findAnswerInBank -- a
// missing Supabase/Voyage connection or a query error just means an empty
// result, never a thrown error.
async function queryChapterChunks(
  scope: Omit<AnswerScope, "question">,
  queryText: string,
  matchCount: number
): Promise<ChapterChunkMatch[]> {
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
    p_match_count: matchCount,
  });

  if (error) {
    console.error("Chapter chunk retrieval failed:", error);
    return [];
  }

  type Row = {
    document_id: string;
    title: string;
    chapter: string;
    topic: string;
    content: string;
    similarity: number;
  };
  return ((data ?? []) as Row[])
    .filter((row) => row.similarity >= MIN_SIMILARITY)
    .map((row) => ({
      documentId: row.document_id,
      title: row.title,
      chapter: row.chapter,
      topic: row.topic,
      content: row.content,
      similarity: row.similarity,
    }));
}

export async function findRelevantChapterChunks(
  scope: Omit<AnswerScope, "question">,
  queryText: string
): Promise<string[]> {
  const matches = await queryChapterChunks(scope, queryText, CHAT_MATCH_COUNT);
  return matches.map((m) => m.content);
}

export async function searchChapterNotes(
  scope: { boardId: string; gradeId: string; subjectId: string; medium: Medium },
  queryText: string
): Promise<ChapterChunkMatch[]> {
  return queryChapterChunks(scope, queryText, SEARCH_MATCH_COUNT);
}
