// Resolving who a broadcast reaches, and materializing that into
// broadcast_recipients -- the one genuinely cross-cutting piece of logic
// in this service. Kept out of the web app (which owns every other
// broadcasts/* write) because it queries across subscriptions and
// subscription_subjects to compute a population, not a single scoped row,
// and because "how many people did this actually reach" is worth a single
// source of truth rather than being re-derived wherever a send button
// happens to live.
import { getSupabaseClient } from "./supabaseClient.js";
import type { Medium, SendBroadcastResponse } from "./types.js";

// Mirrors how /admin/catalog and the rest of this app treat an unset
// filter: null on any of these means "every value for that dimension",
// not "nothing matches". subjectId is matched through subscription_subjects
// (a subscription's board/grade/medium live on the subscription row itself,
// but its subject list is a many-to-many join) -- an unset subjectId means
// "match on board/grade/medium alone, regardless of which subjects a
// student is subscribed to".
export async function resolveAudienceUserIds(scope: {
  boardId: string | null;
  gradeId: string | null;
  subjectId: string | null;
  medium: Medium | null;
}): Promise<string[]> {
  const supabase = getSupabaseClient();

  let query = supabase.from("subscriptions").select("user_id, subscription_subjects(subject_id)").eq(
    "status",
    "active"
  );
  if (scope.boardId) query = query.eq("board_id", scope.boardId);
  if (scope.gradeId) query = query.eq("grade_id", scope.gradeId);
  if (scope.medium) query = query.eq("medium", scope.medium);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to resolve broadcast audience: ${error.message}`);

  const rows = (data ?? []) as unknown as { user_id: string; subscription_subjects: { subject_id: string }[] }[];
  const userIds = new Set<string>();
  for (const row of rows) {
    if (!scope.subjectId) {
      userIds.add(row.user_id);
      continue;
    }
    if (row.subscription_subjects.some((s) => s.subject_id === scope.subjectId)) {
      userIds.add(row.user_id);
    }
  }
  return [...userIds];
}

// Upserts broadcast_recipients for every resolved user (ignoring rows that
// already exist -- a send should be safe to retry after a partial failure
// without double-counting or erroring on the unique(broadcast_id, user_id)
// constraint), then flips the broadcast to 'sent'. Called only once per
// broadcast in the normal flow (the web app only shows "Send" while
// status='draft'), but this function itself doesn't re-check status --
// callers own that guard, same split as the rest of this service.
export async function sendBroadcast(
  broadcastId: string,
  scope: { boardId: string | null; gradeId: string | null; subjectId: string | null; medium: Medium | null }
): Promise<SendBroadcastResponse> {
  const supabase = getSupabaseClient();

  const userIds = await resolveAudienceUserIds(scope);

  if (userIds.length > 0) {
    const rows = userIds.map((userId) => ({ broadcast_id: broadcastId, user_id: userId }));
    const { error } = await supabase
      .from("broadcast_recipients")
      .upsert(rows, { onConflict: "broadcast_id,user_id", ignoreDuplicates: true });
    if (error) throw new Error(`Failed to fan out broadcast recipients: ${error.message}`);
  }

  const { error: updateError } = await supabase
    .from("broadcasts")
    .update({ status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", broadcastId);
  if (updateError) throw new Error(`Failed to mark broadcast as sent: ${updateError.message}`);

  return { recipientCount: userIds.length };
}
