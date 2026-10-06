// USD cost per LLM call, from token counts. Deliberately never guesses: a
// model with no known rate returns null cost (tokens are still recorded) so
// the admin UI can show "unknown" rather than a silently wrong number.
export type PricingRate = { inputPerMTok: number; outputPerMTok: number };

// Anthropic's published first-party API pricing (USD per million tokens), as
// of 2026-06-24. Override any entry -- or add pricing for another
// provider/model, e.g. Azure OpenAI, whose rates vary by region/agreement
// and aren't published the same way -- via LLM_PRICING_JSON (see
// .env.example). Sonnet 5's introductory rate ($2/$10, through 2026-08-31)
// is intentionally not the default here; the standard rate is, so a stale
// deploy doesn't silently under-count cost once the intro period ends --
// set an override if you want the intro rate reflected while it's active.
const DEFAULT_ANTHROPIC_PRICING: Record<string, PricingRate> = {
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-mythos-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

// Google's published Gemini Developer API pricing (USD per million tokens),
// as of 2026-10. gemini-2.5-pro's rate here is its <=200K-context tier
// ($1.25/$10) -- the >200K tier ($2.50/$15, applied to the WHOLE prompt, not
// just the excess) isn't modeled by this flat-rate PricingRate shape, same
// limitation as every other model here having one rate rather than one per
// context-length bracket. This app's own prompts (even with multi-turn
// history) never realistically approach 200K tokens, so the flat rate is
// accurate for actual usage; set a LLM_PRICING_JSON override if that
// changes.
//
// gemini-2.5-flash has NO entry here anymore -- Google retired it (see
// llm.ts's own comment on GEMINI_TIER_MODELS for the production 404 that
// caught this) in favor of gemini-3.8-flash, whose real rate isn't added
// here: the only numbers found for it were a time-limited introductory
// price from third-party aggregator sites that disagreed with each other,
// not confirmed against Google's own pricing page -- exactly the kind of
// unverified guess that got gemini-2.5-flash's own replacement name wrong
// the first time. Until confirmed, a gemini-3.8-flash call reports token
// counts with no dollar cost (getPricing returns null, same as any other
// unpriced model) rather than a dollar figure that might be confidently
// wrong. Set it via LLM_PRICING_JSON once you've confirmed the real rate
// (e.g. from an invoice, or Google's own https://ai.google.dev/pricing).
const DEFAULT_GEMINI_PRICING: Record<string, PricingRate> = {
  "gemini-2.5-pro": { inputPerMTok: 1.25, outputPerMTok: 10 },
  "gemini-2.5-flash-lite": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
};

let cachedOverrides: Record<string, PricingRate> | undefined;

function loadOverrides(): Record<string, PricingRate> {
  if (cachedOverrides) return cachedOverrides;
  const raw = process.env.LLM_PRICING_JSON;
  if (!raw) {
    cachedOverrides = {};
    return cachedOverrides;
  }
  try {
    cachedOverrides = JSON.parse(raw) as Record<string, PricingRate>;
  } catch (err) {
    console.error("Failed to parse LLM_PRICING_JSON, ignoring:", err);
    cachedOverrides = {};
  }
  return cachedOverrides;
}

export function getPricing(provider: string, model: string): PricingRate | null {
  const overrides = loadOverrides();
  const key = `${provider}:${model}`;
  if (overrides[key]) return overrides[key];
  if (provider === "anthropic" && DEFAULT_ANTHROPIC_PRICING[model]) {
    return DEFAULT_ANTHROPIC_PRICING[model];
  }
  if (provider === "gemini" && DEFAULT_GEMINI_PRICING[model]) {
    return DEFAULT_GEMINI_PRICING[model];
  }
  return null;
}

export function calculateCostUsd(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number
): number | null {
  const rate = getPricing(provider, model);
  if (!rate) {
    console.warn(
      `No pricing configured for ${provider}:${model} -- set LLM_PRICING_JSON to enable cost tracking ` +
        "for this model. Recording token counts without a dollar cost."
    );
    return null;
  }
  return (promptTokens / 1_000_000) * rate.inputPerMTok + (completionTokens / 1_000_000) * rate.outputPerMTok;
}
