import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, LlmProvider } from "@/lib/supabase/types";

// Replaces usageLimits.ts's whole monthly/trial-cap model -- see
// supabase/migrations/0055_student_wallets.sql. There is no more
// trial-vs-active distinction: every account has exactly one wallet
// (balance_tokens, llm_provider), created at balance 0 alongside its
// profile row, and every LLM-calling route in this app gates on the same
// `balance > 0` check before spending anything. The real deduction happens
// server-side in services/observability/src/server.ts, right after it
// computes a call's real cost -- this is purely a read.
export const WALLET_EXHAUSTED_MESSAGE =
  "Your account has run out of tokens. Recharge to keep using the tutor.";

export async function getWalletBalance(
  admin: SupabaseClient<Database>,
  userId: string,
): Promise<{ balance: number; provider: LlmProvider }> {
  const { data } = await admin
    .from("student_wallets")
    .select("balance_tokens, llm_provider")
    .eq("user_id", userId)
    .maybeSingle();

  // No row should be reachable in practice (handle_new_tutorops_user
  // always creates one alongside profiles) -- defaulting to an exhausted,
  // gemini wallet rather than throwing is the safer failure mode for a
  // gate check: it blocks the request instead of letting a student with no
  // wallet row somehow slip through unmetered.
  return {
    balance: data?.balance_tokens ?? 0,
    provider: data?.llm_provider ?? "gemini",
  };
}
