// Durable store for one generated summary per syllabus topic (see
// supabase/migrations/0013_topic_summaries_and_exercise_search.sql). Like
// cache.ts and answerBank.ts, fails open -- a missing Supabase connection or
// a query error just means the summary can't be looked up/saved, not that
// the request fails; the caller falls through to generating one fresh.
import { getSupabaseClient } from "./supabaseClient.js";

export async function getStoredTopicSummary(topicId: string): Promise<string | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("topic_summaries")
    .select("summary")
    .eq("topic_id", topicId)
    .maybeSingle();

  if (error) {
    console.error("Failed to look up topic summary:", error);
    return null;
  }
  return data?.summary ?? null;
}

export async function storeTopicSummary(topicId: string, summary: string): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  const { error } = await supabase.from("topic_summaries").insert({ topic_id: topicId, summary });
  if (error) {
    console.error("Failed to store topic summary:", error);
  }
}
