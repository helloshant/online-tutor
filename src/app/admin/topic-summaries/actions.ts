"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
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

// Bulk counterpart to rejectTopicSummary above -- marks EVERY currently-
// servable summary (approved or pending_review; an already-rejected row is
// left alone, there's nothing to regenerate) as rejected and invalidates
// each one's cache entry, exactly what rejecting it by hand one row at a
// time would do. Built for one specific situation: a prompt change (e.g.
// SUMMARY_EMPHASIS_RULE in the orchestrator's own prompts.ts, added so new
// summaries actually use markdown bold/italic) that should also apply to
// every summary already cached, not just new ones from here on -- without
// this, a row generated under the OLD prompt just sits there unchanged
// forever, since nothing else in this app ever re-generates an
// already-stored summary on its own.
//
// The next student to open each affected topic regenerates it fresh under
// whatever prompt is live at that moment, and sees it immediately --
// server.ts's own /v1/topic-summary route serves a fresh pending_review
// row right away (see that route's own respond() call for the "database"
// source, gated only on status !== "rejected"), the same as any other
// regeneration. No separate admin re-approval is required before a
// student sees the new text; approval here is a parallel quality check,
// not a serving gate -- re-review at your own pace afterward.
export async function regenerateAllTopicSummaries() {
  await requireAdminPage("topic_summaries");
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("topic_summaries")
    .select("id, topic_id, language")
    .neq("validation_status", "rejected");
  if (error) {
    console.error("Failed to load topic summaries for bulk regeneration:", error);
    redirect("/admin/topic-summaries?regenerateError=1");
  }

  const rows = data ?? [];
  if (rows.length > 0) {
    const { error: updateError } = await supabase
      .from("topic_summaries")
      .update({ validation_status: "rejected" })
      .in(
        "id",
        rows.map((r) => r.id)
      );
    if (updateError) {
      console.error("Failed to bulk-reject topic summaries:", updateError);
      redirect("/admin/topic-summaries?regenerateError=1");
    }

    // Best-effort, one call per row -- same "don't let one bad row block
    // the rest" posture this app already uses for any loop of independent
    // side effects (see e.g. ocrPipeline.ts's own per-page chunkErrors). A
    // cache entry that fails to invalidate here still expires on its own
    // TTL eventually; it just means that one topic keeps serving its old,
    // unformatted text a little longer, not that the bulk action fails.
    await Promise.allSettled(rows.map((r) => invalidateCachedTopicSummary(r.topic_id, r.language as Medium)));
  }

  revalidatePath("/admin/topic-summaries");
  redirect(`/admin/topic-summaries?regenerated=${rows.length}`);
}
