-- Follow-up to 0038_archetype_miner.sql: the three explicitly-deferred
-- pieces from that first pass -- an admin UI (this migration adds the page
-- permission + the tables it needs), the ArchetypeFamily cross-level
-- progression layer (typed in services/archetype-miner/src/types.ts
-- already, unbuilt until now), and reusable curriculum-taxonomy storage
-- (previously: pass curriculum_taxonomy_text by hand on every single
-- run submission).

-- ---------------------------------------------------------------------------
-- New admin page: "archetype_miner". Same grandfathering approach every
-- earlier page addition (0008, 0019, 0024, 0026, 0028, 0031) used, so this
-- doesn't silently lock out an admin who could already reach every other
-- page.
-- ---------------------------------------------------------------------------
alter table public.admin_page_permissions drop constraint admin_page_permissions_page_check;
alter table public.admin_page_permissions add constraint admin_page_permissions_page_check
  check (page in ('users', 'catalog', 'answer_bank', 'observability', 'coupons', 'chapter_notes', 'topic_summaries', 'broadcasts', 'feedback', 'archetype_miner'));

insert into public.admin_page_permissions (user_id, page)
select p.id, 'archetype_miner'
from public.profiles p
where p.role = 'admin'
on conflict (user_id, page) do nothing;

-- ---------------------------------------------------------------------------
-- Curriculum taxonomy documents -- one per curriculum_source identity
-- (type + name + region), reused automatically by every future pipeline
-- run for that source instead of needing curriculum_taxonomy_text pasted
-- into every single run submission. Plain admin CRUD, same posture as
-- chapter_documents: `web` reads/writes this directly with its own
-- service-role admin client (see src/app/admin/archetype-miner/taxonomies),
-- not through the archetype-miner service -- there's no cross-cutting
-- logic here, just text an admin maintains. archetype-miner's own
-- pipelineRunner reads it (service-role) to resolve a run's taxonomy when
-- the run submission itself doesn't supply one directly.
create table public.archetype_curriculum_taxonomies (
  id uuid primary key default gen_random_uuid(),
  curriculum_source_type text not null check (curriculum_source_type in ('school_board', 'university_program')),
  curriculum_source_name text not null,
  country_or_region text,
  -- Generated, not just `country_or_region` itself, so the uniqueness
  -- constraint below actually holds for a null region -- Postgres treats
  -- two NULLs as distinct for uniqueness purposes, which would otherwise
  -- silently allow duplicate rows for every source that has no region set
  -- (the common case: most school boards/university programs here won't
  -- set one).
  country_or_region_key text generated always as (coalesce(country_or_region, '')) stored,
  taxonomy_text text not null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (curriculum_source_type, curriculum_source_name, country_or_region_key)
);

alter table public.archetype_curriculum_taxonomies enable row level security;

create policy "archetype_curriculum_taxonomies: admin can read" on public.archetype_curriculum_taxonomies
  for select using (public.is_admin());
create policy "archetype_curriculum_taxonomies: admin can write" on public.archetype_curriculum_taxonomies
  for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- ArchetypeFamily (v2 design doc §2.4) -- relates the SAME underlying
-- reasoning skill recurring across education_context scopes at increasing
-- rigor (e.g. "solve for an unknown from a stated condition": grade 9
-- linear equations -> grade 10 quadratics -> grade 11 sequences ->
-- Bachelor's linear algebra), WITHOUT merging the archetypes themselves --
-- merging would violate the level-appropriateness split rule those
-- archetypes were correctly split by in the first place. Deliberately NOT
-- scoped to one archetype_pipeline_runs row (unlike every table in
-- 0038_archetype_miner.sql): a family's whole reason to exist is relating
-- archetypes that were very likely mined in SEPARATE runs (a grade-9 run,
-- an undergraduate run, ...), so it has no single run to belong to.
create table public.archetype_families (
  family_id uuid primary key default gen_random_uuid(),
  family_name text not null,
  member_archetype_ids jsonb not null,
  progression_notes text not null,
  -- The subject_or_course this family-mining pass was scoped to (see
  -- services/archetype-miner/src/stage4FamilyMiner.ts) -- lets the admin
  -- UI list/filter families the same way it lists/filters archetypes,
  -- without unpacking member archetypes to find it.
  subject_or_course text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index archetype_families_subject_idx on public.archetype_families (subject_or_course);

alter table public.archetype_families enable row level security;

create policy "archetype_families: admin can read" on public.archetype_families
  for select using (public.is_admin());
