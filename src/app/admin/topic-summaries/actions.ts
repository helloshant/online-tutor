"use server";

import { revalidatePath } from "next/cache";
import { requireAdminPage } from "@/lib/auth";
import { invalidateCachedTopicSummary } from "@/lib/orchestratorClient";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Medium } from "@/lib/supabase/types";

// Promotes a pending_review summary to approved -- from this point it's
// what the orchestrator's /v1/topic-summary cache/database stages serve to
// every student who opens this topic (see 0026_topic_summary_review.sql).
// No cache invalidation needed here: an approved row was never cached while
// pending (the whole point of the gate), so there's nothing stale to clear.
export async function approveTopicSummary(id: string) {
  await requireAdminPage("topic_summaries");
  const supabase = createAdminClient();
  await supabase.from("topic_summaries").update({ validation_status: "approved" }).eq("id", id);
  revalidatePath("/admin/topic-summaries");
}

// Demotes a summary (whether it was pending_review or a previously-approved
// one that turned out wrong) -- the next student to open this topic in this
// language regenerates from scratch rather than being served the rejected
// text. topicId + language are passed alongside id (rather than looked up
// again) so the matching Redis entry can be cleared immediately instead of
// surviving until its TTL expires -- same reasoning as answer-bank's
// rejectAnswer. A topic now has one row *per language* (see
// 0027_topic_summary_language.sql), so language is required to invalidate
// the right cache key -- rejecting the English row must not clear a
// perfectly good Bengali one for the same topic, or vice versa.
export async function rejectTopicSummary(id: string, topicId: string, language: string) {
  await requireAdminPage("topic_summaries");
  const supabase = createAdminClient();
  await supabase.from("topic_summaries").update({ validation_status: "rejected" }).eq("id", id);
  await invalidateCachedTopicSummary(topicId, language as Medium);
  revalidatePath("/admin/topic-summaries");
}

// Removes the row entirely -- unlike reject (which keeps a record so the
// review queue shows what was turned down), this is for clearing out
// clutter once a rejected summary no longer needs to be kept for reference.
export async function deleteTopicSummary(id: string, topicId: string, language: string) {
  await requireAdminPage("topic_summaries");
  const supabase = createAdminClient();
  await supabase.from("topic_summaries").delete().eq("id", id);
  await invalidateCachedTopicSummary(topicId, language as Medium);
  revalidatePath("/admin/topic-summaries");
}
