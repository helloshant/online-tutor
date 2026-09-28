import { getSupabaseClient } from "./supabaseClient.js";
import type { CurriculumSource } from "./types.js";

// Plain admin CRUD (src/app/admin/archetype-miner/taxonomies in the web
// app writes this table directly against Supabase -- see
// supabase/migrations/0039_archetype_miner_admin_and_families.sql's own
// comment on why: no cross-cutting logic here, just text an admin
// maintains). This service only ever READS it, to resolve a run's
// curriculum taxonomy automatically when the run submission itself didn't
// supply curriculum_taxonomy_text directly -- so an admin who's already
// saved a syllabus document for "CBSE Mathematics" never has to re-paste
// it into every future run against that same curriculum_source.
async function lookupTaxonomyByKey(
  source: Pick<CurriculumSource, "type" | "name">,
  regionKey: string
): Promise<{ taxonomyText: string | undefined; error: unknown }> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("archetype_curriculum_taxonomies")
    .select("taxonomy_text")
    .eq("curriculum_source_type", source.type)
    .eq("curriculum_source_name", source.name)
    .eq("country_or_region_key", regionKey)
    .maybeSingle();
  return { taxonomyText: data?.taxonomy_text ?? undefined, error };
}

// Confirmed live in production: a taxonomy generated via the admin page's
// own "Generate from this app's own syllabus catalogue" button is always
// saved with a BLANK region (that generator has no region field at all --
// see syllabusTaxonomyText.ts), but a real run submission commonly does
// carry one (e.g. "India" for a CBSE run, typed into the Submit Run
// form's own "Country / region" field). The exact-match lookup this used
// to be silently found nothing for that run -- no error anywhere, Stage 1
// just fell back to classifying without a taxonomy at all, which is
// exactly what then required a manual Curriculum reconciliation pass to
// fix up afterward. A real, specifically-regional taxonomy (should one
// ever be saved) still wins when it exists -- this only falls back to the
// source's own blank-region taxonomy when a region was given AND nothing
// matched it exactly, never the other way around.
export async function lookupStoredTaxonomy(source: CurriculumSource): Promise<string | undefined> {
  const regionKey = source.country_or_region ?? "";

  const exact = await lookupTaxonomyByKey(source, regionKey);
  if (exact.error) {
    console.warn("Failed to look up a stored curriculum taxonomy (continuing without one):", exact.error);
    return undefined;
  }
  if (exact.taxonomyText) return exact.taxonomyText;
  if (!regionKey) return undefined;

  const fallback = await lookupTaxonomyByKey(source, "");
  if (fallback.error) {
    console.warn("Failed to look up a stored curriculum taxonomy (region fallback) (continuing without one):", fallback.error);
    return undefined;
  }
  return fallback.taxonomyText;
}
