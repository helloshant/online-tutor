// Retrieval half of the RAG feature (see chapterDocuments.ts for the
// embed/store half and supabase/migrations/0024_chapter_documents_rag.sql /
// 0025_chapter_chunk_metadata.sql for match_chapter_chunks). Called from
// server.ts's /v1/chat stage 4, right before the LLM call, so a chat reply
// can be grounded in real admin-authored chapter content instead of the
// LLM's own general knowledge -- unlike the answer bank's exact-question
// dedup, this is content *augmentation*, not a lookup that can
// short-circuit the LLM call.
import { getSupabaseClient } from "./supabaseClient.js";
import { embed } from "./voyageClient.js";
import type { AnswerScope } from "./types.js";

// Below this, a "match" shares too little meaning with the question to be
// worth quoting at the model -- an irrelevant excerpt is worse than none,
// since it can distract the model into answering the excerpt instead of the
// actual question. Similarity here is cosine similarity (see
// match_chapter_chunks), not ts_rank, so this isn't comparable to
// answerBank.ts's MIN_RANK despite the similar-looking threshold. 0.55 (up
// from an initial 0.5) matches the low end of the starting range suggested
// by this app's own RAG guardrails notes for a similarity cutoff before
// even calling the LLM -- treat as a starting point to tune against real
// usage, not a value derived from this app's own data.
const MIN_SIMILARITY = 0.55;
const MATCH_COUNT = 4;

export type RetrievedChunk = {
  content: string;
  // Both null for a chunk that came from the naive paste-and-auto-chunk
  // path (chunkText in chapterDocuments.ts), which has no per-piece
  // metadata of its own -- only a chunk from the pre-chunked JSON import
  // carries these. Callers must handle null gracefully, not assume every
  // chunk has them.
  fieldType: string | null;
  citation: string | null;
};

// Fails open at every step, same philosophy as findAnswerInBank -- a
// missing Supabase/Voyage connection or a query error just means the chat
// reply proceeds without retrieved context, never that the request fails.
export async function findRelevantChapterChunks(
  scope: Omit<AnswerScope, "question">,
  queryText: string
): Promise<RetrievedChunk[]> {
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

  type Row = { content: string; field_type: string | null; citation: string | null; similarity: number };
  return ((data ?? []) as Row[])
    .filter((row) => row.similarity >= MIN_SIMILARITY)
    .map((row) => ({ content: row.content, fieldType: row.field_type, citation: row.citation }));
}
