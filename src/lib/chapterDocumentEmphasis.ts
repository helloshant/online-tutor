import "server-only";

import { addChapterDocumentEmphasis, embedChapterDocument } from "@/lib/orchestratorClient";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Medium } from "@/lib/supabase/types";

export type EmphasisPassResult = {
  verifiedChunks: number;
  failedChunks: number;
  changed: boolean;
  embedded: boolean;
};

// Shared by every caller that retrofits emphasis onto a chapter document --
// the single-document admin action, and the bulk "Add emphasis to all" run
// (see emphasisRunStore.ts) -- both need the exact same save+re-embed
// sequence, just driven from different places. Pulled out of actions.ts
// (a "use server" file, where every export must itself be an async Server
// Action) so the bulk run's plain API route handlers can call it directly
// too, without it becoming a client-invokable action of its own.
//
// Runs one document through the orchestrator's /v1/chapter-documents/
// add-emphasis, and if (and only if) anything actually came back
// verified-different from what was sent, saves the result and re-embeds it
// -- exactly the same save+re-embed sequence saveChapterDocument runs after
// an ordinary manual edit, since as far as chapter_document_chunks is
// concerned this *is* an edit, just one the admin didn't type by hand.
// Returns null on an outright request failure (network/orchestrator down);
// the caller decides how to surface that.
export async function runEmphasisPass(
  supabase: ReturnType<typeof createAdminClient>,
  doc: { id: string; topic_id: string; content: string }
): Promise<EmphasisPassResult | null> {
  let result;
  try {
    result = await addChapterDocumentEmphasis(doc.content);
  } catch (err) {
    console.error(`Chapter document emphasis request failed for document ${doc.id}:`, err);
    return null;
  }

  const changed = result.content !== doc.content;
  if (!changed) {
    // Every chunk either failed verification or genuinely had nothing left
    // to mark -- either way there's nothing new to save or re-embed.
    return { verifiedChunks: result.verifiedChunks, failedChunks: result.failedChunks, changed: false, embedded: true };
  }

  const { error: updateError } = await supabase
    .from("chapter_documents")
    .update({ content: result.content })
    .eq("id", doc.id);
  if (updateError) {
    console.error(`Failed to save emphasized content for document ${doc.id}:`, updateError);
    return null;
  }

  // content changed -- chapter_document_chunks needs regenerating to match,
  // same as any other content edit (see saveChapterDocument above).
  const { data: topic, error: topicError } = await supabase
    .from("syllabus_topics")
    .select("board_id, grade_id, subject_id, medium")
    .eq("id", doc.topic_id)
    .single();

  let embedded = false;
  if (topicError || !topic) {
    console.error(`Failed to look up topic scope to re-embed document ${doc.id} after emphasis pass:`, topicError);
  } else {
    try {
      const embedResult = await embedChapterDocument({
        documentId: doc.id,
        topicId: doc.topic_id,
        boardId: topic.board_id,
        gradeId: topic.grade_id,
        subjectId: topic.subject_id,
        medium: topic.medium as Medium,
        content: result.content,
      });
      embedded = embedResult.embedded;
    } catch (err) {
      console.error(`Re-embedding request failed for document ${doc.id} after emphasis pass:`, err);
    }
  }

  return { verifiedChunks: result.verifiedChunks, failedChunks: result.failedChunks, changed: true, embedded };
}
