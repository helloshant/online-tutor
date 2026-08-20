// Durable store for generated summaries per syllabus topic (see
// supabase/migrations/0013_topic_summaries_and_exercise_search.sql, extended
// by 0026_topic_summary_review.sql with an admin-review gate, and by
// 0027_topic_summary_language.sql with a language dimension). Like cache.ts
// and answerBank.ts, fails open -- a missing Supabase connection or a query
// error just means the summary can't be looked up/saved, not that the
// request fails; the caller falls through to generating one fresh.
import { getSupabaseClient } from "./supabaseClient.js";
import type { Medium } from "./types.js";

export type TopicSummaryValidationStatus = "pending_review" | "approved" | "rejected";

export type StoredTopicSummary = { summary: string; status: TopicSummaryValidationStatus };

// One row per (topic, language) now -- a topic's own real medium (e.g. the
// English subject's always-English content) and a student's native-medium
// translation of it are stored as two independent rows, each with its own
// review status. Returns the row regardless of status -- callers decide
// what a non-'approved' row means for them (server.ts's /v1/topic-summary
// only treats 'approved' as a servable database hit, but still needs to see
// a 'pending_review' row to avoid re-generating on every click while one
// awaits admin review; see that handler for the full reasoning).
export async function getStoredTopicSummary(
  topicId: string,
  language: Medium
): Promise<StoredTopicSummary | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("topic_summaries")
    .select("summary, validation_status")
    .eq("topic_id", topicId)
    .eq("language", language)
    .maybeSingle();

  if (error) {
    console.error("Failed to look up topic summary:", error);
    return null;
  }
  if (!data) return null;
  return { summary: data.summary, status: data.validation_status as TopicSummaryValidationStatus };
}

// Every freshly LLM-generated summary lands here as 'pending_review', never
// immediately servable -- see 0026_topic_summary_review.sql's comment on why
// there's no auto-approve heuristic the way answer-bank entries have one.
// Upserts on (topic_id, language) (unique) rather than a plain insert: a
// given topic+language can be regenerated more than once before an admin
// gets to it (e.g. after a rejection, or simply another click before
// review), and there is only ever one summary row per topic per language.
export async function upsertTopicSummary(topicId: string, language: Medium, summary: string): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  const { error } = await supabase
    .from("topic_summaries")
    .upsert(
      {
        topic_id: topicId,
        language,
        summary,
        validation_status: "pending_review",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "topic_id,language" }
    );
  if (error) {
    console.error("Failed to store topic summary:", error);
  }
}
