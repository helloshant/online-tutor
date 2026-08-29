import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { saveTaxonomyAction, deleteTaxonomyAction } from "../actions";
import type { ArchetypeCurriculumTaxonomyRow } from "@/lib/archetypeMinerTypes";

export default async function ArchetypeTaxonomiesPage() {
  await requireAdminPage("archetype_miner");
  const admin = createAdminClient();

  const { data } = await admin
    .from("archetype_curriculum_taxonomies")
    .select("*")
    .order("curriculum_source_name", { ascending: true });
  const taxonomies = (data ?? []) as ArchetypeCurriculumTaxonomyRow[];

  return (
    <div>
      <Link href="/admin/archetype-miner" className="text-sm text-brand hover:underline">
        ← Archetype Miner
      </Link>

      <h1 className="mt-4 text-xl font-semibold">Curriculum taxonomies</h1>
      <p className="mt-1 text-sm text-foreground/60">
        One saved document per curriculum source (board or university program) — reused
        automatically by every future pipeline run against that exact source, instead of pasting
        it in per run. Most university courses won&apos;t have one; Stage 1 classifies at capped
        confidence for those, exactly as intended.
      </p>

      <details className="mt-6 rounded-xl border border-border bg-surface">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium hover:bg-brand/5">
          Add / update a taxonomy
        </summary>
        <form action={saveTaxonomyAction} className="space-y-3 border-t border-border p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-xs text-foreground/60">
              Curriculum source type
              <select
                name="curriculumSourceType"
                required
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
              >
                <option value="school_board">School board</option>
                <option value="university_program">University program</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-foreground/60">
              Curriculum source name — must match exactly what a run submits
              <input
                name="curriculumSourceName"
                required
                placeholder="e.g. CBSE"
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-foreground/60">
              Country / region (optional)
              <input
                name="countryOrRegion"
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs text-foreground/60">
            Taxonomy text (syllabus / chapter-topic-concept structure)
            <textarea
              name="taxonomyText"
              required
              rows={10}
              className="rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-xs"
            />
          </label>
          <button className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-dark">
            Save
          </button>
          <p className="text-xs text-foreground/40">
            Saving with the same type + name + region as an existing row updates it in place
            (upsert), it doesn&apos;t create a duplicate.
          </p>
        </form>
      </details>

      <div className="mt-6 space-y-3">
        {taxonomies.map((t) => (
          <details key={t.id} className="rounded-xl border border-border bg-surface">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium hover:bg-brand/5">
              {t.curriculum_source_name}
              {t.country_or_region && ` (${t.country_or_region})`}{" "}
              <span className="text-xs font-normal text-foreground/40">
                {t.curriculum_source_type === "school_board" ? "school board" : "university program"} · updated{" "}
                {new Date(t.updated_at).toLocaleDateString()}
              </span>
            </summary>
            <div className="border-t border-border p-4">
              <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-background p-3 text-xs">
                {t.taxonomy_text}
              </pre>
              <form action={deleteTaxonomyAction.bind(null, t.id)} className="mt-3">
                <ConfirmSubmitButton
                  confirmMessage={`Delete the taxonomy for ${t.curriculum_source_name}? Future runs against this source will classify without one (capped confidence).`}
                  className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100"
                >
                  Delete
                </ConfirmSubmitButton>
              </form>
            </div>
          </details>
        ))}
        {taxonomies.length === 0 && (
          <p className="rounded-xl border border-border bg-surface p-5 text-center text-sm text-foreground/50">
            No curriculum taxonomies saved yet.
          </p>
        )}
      </div>
    </div>
  );
}
