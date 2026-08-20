import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Medium } from "@/lib/supabase/types";

// Mirrors ENGLISH_SUBJECT_CODE in /api/chat/route.ts -- the toggle only
// ever applies to the English subject (see subjects.code in
// supabase/migrations/0003_seed_catalog.sql), same reasoning as chat: every
// other subject's content only exists in the student's own medium.
const ENGLISH_SUBJECT_CODE = "ENG";

// A topic clicked in the syllabus panel always resolves to one specific
// syllabus_topics row -- the one matching the student's subscribed medium,
// since that's all the panel ever shows. Unlike /api/chat's language
// toggle (which just overrides which `medium` value the orchestrator uses
// for scope filtering, cache keys, etc. -- no single row involved), a topic
// summary/exercise search is inherently pinned to one topic_id: the
// generated content is stored keyed by that exact id (topic_summaries.
// topic_id is unique, answered_questions rows are tagged by topic_id), so
// there's no way to serve "the same topic in a different language" without
// actually switching to a *different* topic row.
//
// Resolves that: when the student wants English and a sibling topic row
// exists with the identical board/grade/subject/chapter/topic text but
// medium = 'English' (e.g. the English-medium row a Bengali-medium one was
// literally duplicated from -- see the README's "Medium-scoped syllabus
// storage" section), that sibling's id is what summaries/exercises should
// actually be generated and cached against. Fails open to the original
// topic (i.e. the toggle has no effect) when no such sibling exists yet --
// there's nothing to switch to, and generating an English summary under
// the original topic_id isn't safe: topic_summaries has exactly one row
// per topic_id, so it would either collide with or silently overwrite the
// native-language summary already cached there.
export async function resolveTopicForLanguagePreference(
  supabase: SupabaseClient<Database>,
  originalTopicId: string,
  topicRow: { board_id: string; grade_id: string; subject_id: string; medium: Medium; chapter: string; topic: string },
  subjectCode: string,
  preferEnglish: boolean
): Promise<{ topicId: string; medium: Medium }> {
  if (!preferEnglish || subjectCode !== ENGLISH_SUBJECT_CODE || topicRow.medium === "English") {
    return { topicId: originalTopicId, medium: topicRow.medium };
  }

  const { data: sibling } = await supabase
    .from("syllabus_topics")
    .select("id")
    .eq("board_id", topicRow.board_id)
    .eq("grade_id", topicRow.grade_id)
    .eq("subject_id", topicRow.subject_id)
    .eq("chapter", topicRow.chapter)
    .eq("topic", topicRow.topic)
    .eq("medium", "English")
    .maybeSingle();

  if (!sibling) return { topicId: originalTopicId, medium: topicRow.medium };
  return { topicId: sibling.id, medium: "English" };
}
