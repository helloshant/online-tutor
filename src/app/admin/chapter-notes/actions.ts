"use server";

import { revalidatePath } from "next/cache";
import { requireAdminPage } from "@/lib/auth";
import { embedChapterDocument } from "@/lib/orchestratorClient";
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
