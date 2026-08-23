"use server";

import { revalidatePath } from "next/cache";
import { requireAdminPage } from "@/lib/auth";
import { embedChapterDocument, importChapterChunks } from "@/lib/orchestratorClient";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ChapterDocumentSourceType, Medium } from "@/lib/supabase/types";

const SOURCE_TYPES: ChapterDocumentSourceType[] = [
  "original",
  "public_domain",
  "cc_licensed",
  "ncert_or_diksha",
  "other",
];

// Shared by both save paths below -- falls back to "original" on anything
// missing/invalid rather than rejecting the save outright, since an author
// who simply doesn't touch this field (the common case) should still get a
// clean, meaningful default rather than a form error.
function readSourceFields(formData: FormData): {
  sourceType: ChapterDocumentSourceType;
  sourceUrl: string | null;
  sourceNote: string | null;
} {
  const rawType = formData.get("sourceType") as string | null;
  const sourceType = SOURCE_TYPES.includes(rawType as ChapterDocumentSourceType)
    ? (rawType as ChapterDocumentSourceType)
    : "original";
  const sourceUrl = ((formData.get("sourceUrl") as string | null) ?? "").trim() || null;
  const sourceNote = ((formData.get("sourceNote") as string | null) ?? "").trim() || null;
  return { sourceType, sourceUrl, sourceNote };
}

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
  const { sourceType, sourceUrl, sourceNote } = readSourceFields(formData);

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
      .update({ title, content, source_type: sourceType, source_url: sourceUrl, source_note: sourceNote })
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
      .insert({
        topic_id: topicId,
        title,
        content,
        source_type: sourceType,
        source_url: sourceUrl,
        source_note: sourceNote,
        created_by: session.user.id,
      })
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
    // How many of chaptersImported required creating a brand-new
    // syllabus_topics row (no existing topic under this book matched that
    // chapter_title) -- surfaced so an admin notices when a typo/rename in
    // the file silently adds a near-duplicate topic instead of updating
    // the one they meant.
    topicsCreated: number;
    // Chapter titles whose embedding call failed (Voyage unreachable,
    // VOYAGE_API_KEY unset, etc.) -- that chapter's document row and raw
    // text are still saved, it just won't be retrievable in chat until
    // re-imported successfully.
    embedFailures: string[];
  };
}

// Bulk counterpart to saveChapterDocument above, for content prepared
// offline as pre-chunked JSON rather than typed/pasted as one block of
// text. Scoped to a whole *book* -- a syllabus_topics "chapter" grouping
// (e.g. "Prose and Poetry"), which commonly holds several distinct topics,
// one per story/poem -- rather than one topic picked up front: a book's
// worth of chapters shouldn't have to be imported one topic at a time when
// the file already carries a chapter_title per chunk. Each distinct
// chapter_number/chapter_title in the JSON is matched (case-insensitively,
// trimmed) against the syllabus_topics rows already under this book; a
// title with no match gets a brand-new topic row created for it
// (sort_order continuing this board/grade/subject/medium's existing
// sequence -- see bulkAddSyllabusTopics in admin/catalog/actions.ts for the
// same pattern). Each chapter's chapter_documents row is then found-or-
// created by (topic_id, title) exactly as before, so re-uploading a
// corrected file updates existing chapters in place instead of duplicating
// them.
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

  const boardId = (formData.get("boardId") as string | null) ?? "";
  const gradeId = (formData.get("gradeId") as string | null) ?? "";
  const subjectId = (formData.get("subjectId") as string | null) ?? "";
  const rawMedium = (formData.get("medium") as string | null) ?? "";
  const book = ((formData.get("chapter") as string | null) ?? "").trim();
  const VALID_MEDIUMS: Medium[] = ["English", "Hindi", "Bengali"];
  if (!boardId || !gradeId || !subjectId || !VALID_MEDIUMS.includes(rawMedium as Medium) || !book) {
    return { error: "Board, grade, subject, medium, and book are all required." };
  }
  const medium = rawMedium as Medium;
  // One provenance claim for the whole book -- a JSON file prepared offline
  // is, by construction, a single authoring pass over a single source (or
  // none), not a mix per chapter.
  const { sourceType, sourceUrl, sourceNote } = readSourceFields(formData);

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

  // Existing topics under this exact book, keyed by trimmed/lowercased
  // topic text -- a chapter_title matching one of these (however it was
  // capitalized in the file) reuses that topic rather than creating a
  // near-duplicate.
  const { data: existingTopics, error: topicsError } = await supabase
    .from("syllabus_topics")
    .select("id, topic, sort_order")
    .eq("board_id", boardId)
    .eq("grade_id", gradeId)
    .eq("subject_id", subjectId)
    .eq("medium", medium)
    .eq("chapter", book)
    .order("sort_order");
  if (topicsError) {
    console.error("Failed to look up existing topics for chapter chunk import:", topicsError);
    return { error: "Could not look up this book's existing topics. Please try again." };
  }

  const topicIdByTitle = new Map((existingTopics ?? []).map((t) => [t.topic.trim().toLowerCase(), t.id]));
  let nextSortOrder = (existingTopics ?? []).reduce((max, t) => Math.max(max, t.sort_order), 0) + 1;

  let chunksImported = 0;
  let topicsCreated = 0;
  const embedFailures: string[] = [];

  for (const { title, pieces } of byChapter.values()) {
    const content = pieces.map((p) => p.text).join("\n\n");

    let topicId = topicIdByTitle.get(title.trim().toLowerCase());
    if (!topicId) {
      const { data: createdTopic, error: createTopicError } = await supabase
        .from("syllabus_topics")
        .insert({
          board_id: boardId,
          grade_id: gradeId,
          subject_id: subjectId,
          medium,
          chapter: book,
          topic: title,
          sort_order: nextSortOrder++,
        })
        .select("id")
        .single();
      if (createTopicError || !createdTopic) {
        console.error(`Failed to create syllabus topic for "${title}":`, createTopicError);
        embedFailures.push(title);
        continue;
      }
      topicId = createdTopic.id;
      topicIdByTitle.set(title.trim().toLowerCase(), topicId);
      topicsCreated++;
    }

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
        .update({ content, source_type: sourceType, source_url: sourceUrl, source_note: sourceNote })
        .eq("id", documentId);
      if (updateError) {
        console.error(`Failed to update chapter document "${title}":`, updateError);
        embedFailures.push(title);
        continue;
      }
    } else {
      const { data: created, error: insertError } = await supabase
        .from("chapter_documents")
        .insert({
          topic_id: topicId,
          title,
          content,
          source_type: sourceType,
          source_url: sourceUrl,
          source_note: sourceNote,
          created_by: session.user.id,
        })
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
        boardId,
        gradeId,
        subjectId,
        medium: medium as Medium,
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
  revalidatePath("/admin/catalog");
  return {
    success: { chaptersImported: byChapter.size, chunksImported, topicsCreated, embedFailures },
  };
}
