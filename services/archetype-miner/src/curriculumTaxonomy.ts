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
export async function lookupStoredTaxonomy(source: CurriculumSource): Promise<string | undefined> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("archetype_curriculum_taxonomies")
    .select("taxonomy_text")
    .eq("curriculum_source_type", source.type)
    .eq("curriculum_source_name", source.name)
    .eq("country_or_region_key", source.country_or_region ?? "")
    .maybeSingle();

  if (error) {
    console.warn("Failed to look up a stored curriculum taxonomy (continuing without one):", error);
    return undefined;
  }
  return data?.taxonomy_text ?? undefined;
}
