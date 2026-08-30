import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { mineFamiliesAction } from "../actions";
import type { ArchetypeFamilyRow } from "@/lib/archetypeMinerTypes";

export default async function ArchetypeFamiliesPage() {
  await requireAdminPage("archetype_miner");
  const admin = createAdminClient();

  const { data } = await admin.from("archetype_families").select("*").order("created_at", { ascending: false });
  const families = (data ?? []) as ArchetypeFamilyRow[];

  return (
    <div>
      <Link href="/admin/archetype-miner" className="text-sm text-brand hover:underline">
        ← Archetype Miner
      </Link>

      <h1 className="mt-4 text-xl font-semibold">Archetype families</h1>
      <p className="mt-1 text-sm text-foreground/60">
        Cross-level progressions — the SAME underlying reasoning skill recurring across education
        levels at increasing rigor (e.g. &quot;solve for an unknown from a stated condition&quot;
        across grade 9 through undergraduate). Never merges the underlying archetypes; each one
        keeps its own level-appropriate scope.
      </p>

      <div className="mt-6 rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold">Mine families for a subject/course</h2>
        <p className="mt-1 text-xs text-foreground/50">
          Runs across every accepted archetype (status reviewed/final, decision KEEP/REVISE/ADD)
          sharing this exact subject_or_course label, across ALL runs/education levels. Enter it
          exactly as it appears on the pipeline runs you want related (e.g. &quot;Mathematics&quot;).
        </p>
        <form action={mineFamiliesAction} className="mt-3 flex flex-wrap items-center gap-2">
          <input
            name="subjectOrCourse"
            required
            placeholder="Subject or course, e.g. Mathematics"
            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          />
          <select
            name="llmProvider"
            defaultValue="default"
            title="LLM provider for this family-mining call -- default defers to the archetype-miner service's own LLM_PROVIDER"
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            <option value="default">Use service default</option>
            <option value="anthropic">Anthropic</option>
            <option value="azure-openai">Azure OpenAI</option>
          </select>
          <button className="shrink-0 rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-dark">
            Mine families
          </button>
        </form>
      </div>

      <div className="mt-6 space-y-3">
        {families.map((f) => (
          <div key={f.family_id} className="rounded-xl border border-border bg-surface p-5">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">{f.family_name}</h3>
              <span className="rounded-full bg-brand/10 px-2 py-0.5 text-xs text-brand">
                {f.subject_or_course}
              </span>
            </div>
            <p className="mt-1.5 text-sm text-foreground/70">{f.progression_notes}</p>
            <p className="mt-2 text-xs text-foreground/40">
              {f.member_archetype_ids.length} member archetype(s): {f.member_archetype_ids.join(", ")}
            </p>
          </div>
        ))}
        {families.length === 0 && (
          <p className="rounded-xl border border-border bg-surface p-5 text-center text-sm text-foreground/50">
            No families mined yet.
          </p>
        )}
      </div>
    </div>
  );
}
