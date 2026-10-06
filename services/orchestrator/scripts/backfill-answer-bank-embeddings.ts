// One-off backfill for supabase/migrations/0053_answer_bank_semantic_
// search.sql: embeds every existing chat-originated answered_questions row
// (topic_id is null -- an exercise row is matched by exact topic_id, never
// question-text similarity, so it's excluded the same way recordAnswer in
// answerBank.ts skips embedding one going forward) that doesn't have an
// embedding yet. Safe to re-run: only ever selects rows still missing one.
//
// Run from services/orchestrator, against the real environment (needs
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/VOYAGE_API_KEY, same as the
// running service's own .env.local):
//   npx tsx scripts/backfill-answer-bank-embeddings.ts
import { getSupabaseClient } from "../src/supabaseClient.js";
import { embed } from "../src/voyageClient.js";

const BATCH_SIZE = 50;

async function main() {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.error(
      "Missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY -- see services/orchestrator/.env.local.",
    );
    process.exit(1);
  }

  let totalEmbedded = 0;
  let totalFailed = 0;

  for (;;) {
    const { data: rows, error } = await supabase
      .from("answered_questions")
      .select("id, question")
      .is("topic_id", null)
      .is("embedding", null)
      .limit(BATCH_SIZE);

    if (error) {
      console.error("Failed to fetch a batch of rows:", error);
      process.exit(1);
    }
    if (!rows || rows.length === 0) break;

    const embeddings = await embed(
      rows.map((r) => r.question as string),
      "document",
    );
    if (!embeddings) {
      console.error(
        "Embedding call failed for this batch (see voyageClient.ts's own logs above) -- stopping rather than retrying forever.",
      );
      process.exit(1);
    }

    for (let i = 0; i < rows.length; i++) {
      const { error: updateError } = await supabase
        .from("answered_questions")
        .update({ embedding: embeddings[i] })
        .eq("id", rows[i].id);
      if (updateError) {
        console.error(`Failed to save embedding for row ${rows[i].id}:`, updateError);
        totalFailed++;
      } else {
        totalEmbedded++;
      }
    }

    console.log(`Embedded ${totalEmbedded} so far (${totalFailed} failed)...`);
  }

  console.log(`Done. ${totalEmbedded} rows embedded, ${totalFailed} failed.`);
  process.exit(totalFailed > 0 ? 1 : 0);
}

main();
