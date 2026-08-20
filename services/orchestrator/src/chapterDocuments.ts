// Turns one admin-authored chapter_documents.content into the embedded
// chapter_document_chunks rows the chat pipeline retrieves from (see
// chapterRag.ts and supabase/migrations/0024_chapter_documents_rag.sql).
// Reached only via the internal /v1/chapter-documents/embed endpoint
// (server.ts), called by the web app's admin action right after it
// writes/updates the chapter_documents row itself -- this service never
// touches that table directly, only the derived chunks.
import { embed } from "./voyageClient.js";
import { getSupabaseClient } from "./supabaseClient.js";
import type { Medium } from "./types.js";

// Sized for retrieval granularity, not for any model's context limit (a
// chat reply only ever gets a handful of chunks stitched in, not the whole
// document) -- big enough that a chunk carries a complete thought, small
// enough that a similarity match points at a specific passage rather than
// half a chapter. Paragraph boundaries are never split except when a single
// paragraph alone exceeds this (rare -- most prose has blank lines every
// few sentences), so retrieval granularity stays natural-language-shaped
// rather than an arbitrary character cutoff.
const TARGET_CHUNK_CHARS = 1500;

export function chunkText(text: string, targetChars = TARGET_CHUNK_CHARS): string[] {
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  function flush() {
    if (current) chunks.push(current);
    current = "";
  }

  for (const paragraph of paragraphs) {
    // A single paragraph longer than the whole target budget can't merge
    // with anything -- hard-split it on its own rather than letting one
    // chunk balloon past every other chunk's size.
    if (paragraph.length > targetChars) {
      flush();
      for (let i = 0; i < paragraph.length; i += targetChars) {
        chunks.push(paragraph.slice(i, i + targetChars));
      }
      continue;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > targetChars) {
      flush();
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  flush();

  return chunks;
}

export type ChapterDocumentScope = {
  topicId: string;
  boardId: string;
  gradeId: string;
  subjectId: string;
  medium: Medium;
};

// One chunk's text plus the metadata a pre-chunked JSON import carries per
// piece (see embedAndStorePrechunkedDocument below) -- both optional since
// the naive-chunking path (embedAndStoreChapterDocument) has neither: a
// paragraph split out of one pasted block of text has no independently
// authored field_type or citation of its own, only the parent document's.
export type PrechunkedPiece = { content: string; fieldType?: string; citation?: string };

type ChunkRow = {
  document_id: string;
  topic_id: string;
  board_id: string;
  grade_id: string;
  subject_id: string;
  medium: Medium;
  chunk_index: number;
  content: string;
  embedding: number[];
  field_type: string | null;
  citation: string | null;
};

// Shared by both embed-and-store paths below: wholesale delete-then-
// reinsert for this one document_id -- simpler and safer than trying to
// diff old/new chunks on a re-save, and cheap enough given a chapter
// document is at most a few dozen chunks. Fails open on the embedding call
// (the document's own raw content is still saved by the caller regardless;
// this just means no retrieval for it until a later re-save succeeds), but
// a Postgres write failure after a successful embed is reported back so the
// caller can surface it rather than silently leaving stale/missing chunks.
async function replaceChunks(
  documentId: string,
  scope: ChapterDocumentScope,
  pieces: PrechunkedPiece[]
): Promise<{ chunkCount: number; embedded: boolean }> {
  const supabase = getSupabaseClient();
  if (!supabase) return { chunkCount: 0, embedded: false };

  // Always clear old chunks first, even if there's nothing to replace them
  // with (e.g. the document was edited down to nothing) -- otherwise a
  // shrunk document would keep serving stale chunks from its previous,
  // longer version.
  const { error: deleteError } = await supabase
    .from("chapter_document_chunks")
    .delete()
    .eq("document_id", documentId);
  if (deleteError) {
    console.error("Failed to clear old chapter document chunks:", deleteError);
  }

  if (pieces.length === 0) return { chunkCount: 0, embedded: true };

  const embeddings = await embed(
    pieces.map((p) => p.content),
    "document"
  );
  if (!embeddings) return { chunkCount: 0, embedded: false };

  const rows: ChunkRow[] = pieces.map((piece, i) => ({
    document_id: documentId,
    topic_id: scope.topicId,
    board_id: scope.boardId,
    grade_id: scope.gradeId,
    subject_id: scope.subjectId,
    medium: scope.medium,
    chunk_index: i,
    content: piece.content,
    embedding: embeddings[i],
    field_type: piece.fieldType ?? null,
    citation: piece.citation ?? null,
  }));

  const { error: insertError } = await supabase.from("chapter_document_chunks").insert(rows);
  if (insertError) {
    console.error("Failed to store chapter document chunks:", insertError);
    return { chunkCount: 0, embedded: false };
  }

  return { chunkCount: pieces.length, embedded: true };
}

// Naive-chunking path: one long block of admin-pasted text, split by
// chunkText() above into paragraph-sized pieces with no field_type/citation
// of their own.
export async function embedAndStoreChapterDocument(
  documentId: string,
  scope: ChapterDocumentScope,
  content: string
): Promise<{ chunkCount: number; embedded: boolean }> {
  return replaceChunks(
    documentId,
    scope,
    chunkText(content).map((content) => ({ content }))
  );
}

// Pre-chunked path: the pieces are already split along real structural
// boundaries by whoever prepared the JSON (see src/app/admin/chapter-notes/
// import-chunks-form.tsx) -- chunkText() is never called here, since
// re-splitting already-correct chunks would just as likely cut across a
// natural boundary as respect one. Each piece keeps its own field_type/
// citation, which the naive path has no equivalent of.
export async function embedAndStorePrechunkedDocument(
  documentId: string,
  scope: ChapterDocumentScope,
  pieces: PrechunkedPiece[]
): Promise<{ chunkCount: number; embedded: boolean }> {
  return replaceChunks(documentId, scope, pieces);
}

// Read side for the topic-summary pipeline's first stage (server.ts's
// /v1/topic-summary, checked before cache/database/LLM): if an admin has
// already authored or imported chapter content for this exact topic, that
// is the summary -- curated, already vouched for, and needs no further
// review the way an LLM-generated one does. Deliberately a plain equality
// lookup on chapter_documents.topic_id, not a semantic search against
// chapter_document_chunks the way chat grounding (chapterRag.ts) works:
// the topic is already known exactly (the student clicked it), so there's
// nothing to search for, and this avoids spending a Voyage embedding call
// on every single topic click.
//
// A topic can have more than one document (e.g. "Chapter summary" and
// "Character notes" as separate admin-authored documents, see
// 0024_chapter_documents_rag.sql's own comment) -- all of them are joined
// together under their own titles rather than guessing which one is "the"
// summary, since field_type/citation (0025_chapter_chunk_metadata.sql) are
// chunk-level metadata an admin sets freely with no fixed vocabulary, not
// a reliable signal to filter documents by.
export async function getStoredChapterSummary(topicId: string): Promise<string | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("chapter_documents")
    .select("title, content")
    .eq("topic_id", topicId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Failed to look up chapter documents for topic summary:", error);
    return null;
  }
  if (!data || data.length === 0) return null;
  if (data.length === 1) return data[0].content;

  return data.map((doc) => `**${doc.title}**\n\n${doc.content}`).join("\n\n---\n\n");
}
