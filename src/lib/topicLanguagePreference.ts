import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Medium } from "@/lib/supabase/types";

// Looks up the *sibling* topic row -- same board/grade/subject/chapter/
// topic text, but a different medium -- e.g. the English-medium row a
// Bengali-medium one was literally duplicated from (see the README's
// "Medium-scoped syllabus storage" section). Used by /api/topics/[id]/
// summary and /exercises when the language toggle wants a different
// language than the clicked topic's own: if a sibling exists, its own
// chapter_documents/topic_summaries/answered_questions are genuinely in
// the requested language, so the full RAG -> cache -> database -> LLM
// pipeline can run against *that* topic's id exactly as it would for any
// ordinary native-language request -- there's no need for a separate
// "responseLanguage" override in that case, since the sibling's own
// `medium` already equals what was asked for.
//
// Returns null when no such row exists -- most topics never get manually
// duplicated into a second medium, so this is the common case, not the
// exception. The caller then falls back to generating fresh via the LLM
// against the *original* topic (with `responseLanguage` overriding just
// the reply language) rather than persisting/caching anything, since
// there is no topic row in the requested language to attach it to.
export async function findSiblingTopic(
  supabase: SupabaseClient<Database>,
  topicRow: { board_id: string; grade_id: string; subject_id: string; chapter: string; topic: string },
  medium: Medium
): Promise<{ id: string } | null> {
  const { data } = await supabase
    .from("syllabus_topics")
    .select("id")
    .eq("board_id", topicRow.board_id)
    .eq("grade_id", topicRow.grade_id)
    .eq("subject_id", topicRow.subject_id)
    .eq("chapter", topicRow.chapter)
    .eq("topic", topicRow.topic)
    .eq("medium", medium)
    .maybeSingle();

  return data ?? null;
}
