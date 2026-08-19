"use server";

import { revalidatePath } from "next/cache";
import { requireAdminPage } from "@/lib/auth";
import { embedChapterDocument, importChapterChunks } from "@/lib/orchestratorClient";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Medium } from "@/lib/supabase/types";

export interface SaveChapterDocumentState {
  error?: string;
  success?: boolean;
  // Set when the row saved but the embedding call itself failed (Voyage
  // unreachable, VOYAGE_API_KEY unset in the orchestrator, etc.) -- the
  // document's raw text is never lost either way, this just tells the admin
  // it won't show up in chat retrieval yet.
  embedWarning?: boolean;
}

export async function saveChapterDocument(
  _prevState: SaveChapterDocumentState,
  formData: FormData
): Promise<SaveChapterDocumentState> {
  const session = await requireAdminPage("chapter_notes");
  const supabase = createAdminClient();

  const id = (formData.get("id") as string | null) || null;
  const title = ((formData.get("title") as string | null) ?? "").trim();
  const content = ((formData.get("content") as string | null) ?? "").trim();
  if (!title) return { error: "Title is required." };
  if (!content) return { error: "Content is required." };

  let documentId: string;
  let topicId: string;

  if (id) {
    // Editing: the topic (and therefore board/grade/subject/medium) is
    // fixed at creation time and isn't editable here -- looked up from the
    // existing row rather than trusted from a hidden form field, so a
    // tampered request can't silently move a document's embeddings into a
    // scope other than the row it's actually attached to.
    const { data: existing, error } = await supabase
      .from("chapter_documents")
      .select("topic_id")
      .eq("id", id)
      .single();
    if (error || !existing) return { error: "This document no longer exists." };
    documentId = id;
    topicId = existing.topic_id;

    const { error: updateError } = await supabase
      .from("chapter_documents")
      .update({ title, content })
      .eq("id", documentId);
    if (updateError) {
      console.error("Failed to update chapter document:", updateError);
      return { error: "Could not save this document. Please try again." };
    }
  } else {
    topicId = (formData.get("topicId") as string | null) ?? "";
    if (!topicId) return { error: "Board, grade, subject, medium, and topic are all required." };

    const { data: created, error: insertError } = await supabase
      .from("chapter_documents")
      .insert({ topic_id: topicId, title, content, created_by: session.user.id })
      .select("id")
      .single();
    if (insertError || !created) {
      console.error("Failed to create chapter document:", insertError);
      return { error: "Could not save this document. Please try again." };
    }
    documentId = created.id;
  }

  // chapter_document_chunks denormalizes board/grade/subject/medium off the
  // topic (see 0024_chapter_documents_rag.sql) so the retrieval RPC can
  // filter on plain equality -- looked up here rather than trusting a
  // second set of hidden form fields, same reasoning as topicId above.
  const { data: topic, error: topicError } = await supabase
    .from("syllabus_topics")
    .select("board_id, grade_id, subject_id, medium")
    .eq("id", topicId)
    .single();
  if (topicError || !topic) {
    console.error("Failed to look up topic scope for chapter document:", topicError);
    return { error: "Saved, but couldn't look up its board/grade/subject scope to index it for search." };
  }

  let embedded = true;
  try {
    const result = await embedChapterDocument({
      documentId,
      topicId,
      boardId: topic.board_id,
      gradeId: topic.grade_id,
      subjectId: topic.subject_id,
      medium: topic.medium as Medium,
      content,
    });
    embedded = result.embedded;
  } catch (err) {
    console.error("Chapter document embedding request failed:", err);
    embedded = false;
  }

  revalidatePath("/admin/chapter-notes");
  return { success: true, embedWarning: !embedded };
}

export async function deleteChapterDocument(id: string) {
  await requireAdminPage("chapter_notes");
  const supabase = createAdminClient();
  // ON DELETE CASCADE on chapter_document_chunks.document_id (see
  // 0024_chapter_documents_rag.sql) removes the derived chunks along with
  // this row -- no separate cleanup call needed.
  await supabase.from("chapter_documents").delete().eq("id", id);
  revalidatePath("/admin/chapter-notes");
}

const MAX_JSON_FILE_BYTES = 5 * 1024 * 1024;

// Shape produced by an offline authoring pass (e.g. an LLM-assisted
// paraphrase-and-chunk step over a real textbook) -- each chunk is already
// split along a real structural boundary (chapter overview, plot summary,
// one vocabulary word, etc.), unlike the single-document form above, which
// always re-splits one pasted block with this app's own naive
// paragraph-based chunker. See chapterDocuments.ts's embedAndStorePrechunkedDocument.
type RawImportChunk = {
  chapter_number: number;
  chapter_title: string;
  field_type?: string;
  text: string;
  citation?: string;
};

function parseImportChunks(raw: unknown): RawImportChunk[] | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { chunks?: unknown }).chunks)) return null;
  const chunks = (raw as { chunks: unknown[] }).chunks;

  const parsed: RawImportChunk[] = [];
  for (const c of chunks) {
    if (
      !c ||
      typeof c !== "object" ||
      typeof (c as RawImportChunk).chapter_number !== "number" ||
      typeof (c as RawImportChunk).chapter_title !== "string" ||
      !(c as RawImportChunk).chapter_title.trim() ||
      typeof (c as RawImportChunk).text !== "string" ||
      !(c as RawImportChunk).text.trim()
    ) {
      return null;
    }
    const entry = c as RawImportChunk;
    parsed.push({
      chapter_number: entry.chapter_number,
      chapter_title: entry.chapter_title,
      text: entry.text,
      field_type: typeof entry.field_type === "string" ? entry.field_type : undefined,
      citation: typeof entry.citation === "string" ? entry.citation : undefined,
    });
  }
  return parsed;
}

export interface ImportChapterChunksState {
  error?: string;
  success?: {
    chaptersImported: number;
    chunksImported: number;
    // Chapter titles whose embedding call failed (Voyage unreachable,
    // VOYAGE_API_KEY unset, etc.) -- that chapter's document row and raw
    // text are still saved, it just won't be retrievable in chat until
    // re-imported successfully.
    embedFailures: string[];
  };
}

// Bulk counterpart to saveChapterDocument above, for content prepared
// offline as pre-chunked JSON rather than typed/pasted as one block of
// text. One admin-selected topic scope applies to every chapter in the
// file (same reasoning the single-document form requires a topic: a
// chapter document is always about exactly one syllabus topic) -- each
// distinct chapter_number/chapter_title pair in the JSON becomes its own
// chapter_documents row under that topic, found-or-created by (topic_id,
// title) so re-uploading a corrected file updates existing chapters
// in place instead of duplicating them.
//
// Important asymmetry with the single-document Edit form: re-saving one of
// these chapters through that plain text form would run it through the
// naive paragraph chunker and wipe out the field_type/citation metadata
// this import preserves -- to update a JSON-imported chapter, re-run this
// import with a corrected file instead.
export async function importChapterChunksJson(
  _prevState: ImportChapterChunksState,
  formData: FormData
): Promise<ImportChapterChunksState> {
  const session = await requireAdminPage("chapter_notes");
  const supabase = createAdminClient();

  const topicId = (formData.get("topicId") as string | null) ?? "";
  if (!topicId) return { error: "Board, grade, subject, medium, and topic are all required." };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Please choose a JSON file." };
  }
  if (file.size > MAX_JSON_FILE_BYTES) {
    return { error: "That file is too large (max 5MB)." };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    return { error: "That file isn't valid JSON." };
  }
  const chunks = parseImportChunks(raw);
  if (!chunks || chunks.length === 0) {
    return {
      error:
        'That file doesn\'t match the expected shape: a top-level "chunks" array, each with numeric chapter_number, string chapter_title and text (field_type/citation optional).',
    };
  }

  const { data: topic, error: topicError } = await supabase
    .from("syllabus_topics")
    .select("board_id, grade_id, subject_id, medium")
    .eq("id", topicId)
    .single();
  if (topicError || !topic) {
    console.error("Failed to look up topic scope for chapter chunk import:", topicError);
    return { error: "Could not look up that topic's board/grade/subject scope." };
  }
  const medium = topic.medium as Medium;

  // Preserves the JSON's own array order as each chapter's chunk_index --
  // not re-sorted by chapter_number, so a file that interleaves chapters
  // still gets each chapter's own pieces numbered 0, 1, 2... in the order
  // they appeared for that chapter specifically.
  const byChapter = new Map<number, { title: string; pieces: RawImportChunk[] }>();
  for (const chunk of chunks) {
    const existing = byChapter.get(chunk.chapter_number);
    if (existing) existing.pieces.push(chunk);
    else byChapter.set(chunk.chapter_number, { title: chunk.chapter_title, pieces: [chunk] });
  }

  let chunksImported = 0;
  const embedFailures: string[] = [];

  for (const { title, pieces } of byChapter.values()) {
    const content = pieces.map((p) => p.text).join("\n\n");

    const { data: existingDoc } = await supabase
      .from("chapter_documents")
      .select("id")
      .eq("topic_id", topicId)
      .eq("title", title)
      .maybeSingle();

    let documentId: string;
    if (existingDoc) {
      documentId = existingDoc.id;
      const { error: updateError } = await supabase
        .from("chapter_documents")
        .update({ content })
        .eq("id", documentId);
      if (updateError) {
        console.error(`Failed to update chapter document "${title}":`, updateError);
        embedFailures.push(title);
        continue;
      }
    } else {
      const { data: created, error: insertError } = await supabase
        .from("chapter_documents")
        .insert({ topic_id: topicId, title, content, created_by: session.user.id })
        .select("id")
        .single();
      if (insertError || !created) {
        console.error(`Failed to create chapter document "${title}":`, insertError);
        embedFailures.push(title);
        continue;
      }
      documentId = created.id;
    }

    try {
      const result = await importChapterChunks({
        documentId,
        topicId,
        boardId: topic.board_id,
        gradeId: topic.grade_id,
        subjectId: topic.subject_id,
        medium,
        chunks: pieces.map((p) => ({ content: p.text, fieldType: p.field_type, citation: p.citation })),
      });
      if (!result.embedded) embedFailures.push(title);
      chunksImported += result.chunkCount;
    } catch (err) {
      console.error(`Chapter chunk import request failed for "${title}":`, err);
      embedFailures.push(title);
    }
  }

  revalidatePath("/admin/chapter-notes");
  return {
    success: { chaptersImported: byChapter.size, chunksImported, embedFailures },
  };
}
