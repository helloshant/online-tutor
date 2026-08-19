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

// Wholesale delete-then-reinsert for this one document_id -- simpler and
// safer than trying to diff old/new chunks on an edit, and cheap enough
// given a chapter document is at most a few dozen chunks. Fails open on the
// embedding call (content is still saved by the caller regardless; this
// just means no retrieval for it until a later re-save succeeds), but a
// Postgres write failure after a successful embed is reported back so the
// caller can surface it rather than silently leaving stale/missing chunks.
export async function embedAndStoreChapterDocument(
  documentId: string,
  scope: ChapterDocumentScope,
  content: string
): Promise<{ chunkCount: number; embedded: boolean }> {
  const supabase = getSupabaseClient();
  if (!supabase) return { chunkCount: 0, embedded: false };

  const chunks = chunkText(content);

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

  if (chunks.length === 0) return { chunkCount: 0, embedded: true };

  const embeddings = await embed(chunks, "document");
  if (!embeddings) return { chunkCount: 0, embedded: false };

  const rows = chunks.map((chunkContent, i) => ({
    document_id: documentId,
    topic_id: scope.topicId,
    board_id: scope.boardId,
    grade_id: scope.gradeId,
    subject_id: scope.subjectId,
    medium: scope.medium,
    chunk_index: i,
    content: chunkContent,
    embedding: embeddings[i],
  }));

  const { error: insertError } = await supabase.from("chapter_document_chunks").insert(rows);
  if (insertError) {
    console.error("Failed to store chapter document chunks:", insertError);
    return { chunkCount: 0, embedded: false };
  }

  return { chunkCount: chunks.length, embedded: true };
}
