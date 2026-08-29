-- ---------------------------------------------------------------------------
-- Question Archetype Miner: storage for the new services/archetype-miner
-- microservice's 5-stage pipeline (Segmenter -> Analyzer -> embed/cluster
-- -> Miner -> Critic), per the researched design
-- (CBSE_Archetype_Pipeline_Redesign.md + its v2 multi-level delta). Mines a
-- reusable "archetype" taxonomy (a fundamentally distinct reasoning
-- pattern, not a wording template) out of a historical question corpus, so
-- a future question generator can vary an archetype's parameters instead
-- of needing a human to invent a new pattern from scratch.
--
-- Every stage's INPUT/OUTPUT is a fixed JSON contract (design principle #1
-- in the source doc: "schema-first"). Rather than widen every nested field
-- (curriculum, skills, confidence, variations, stats, critic_* ...) into
-- its own column -- which would fight that contract instead of serving it,
-- and would need a migration every time the JSON schema gains a field --
-- each stage's full output object is stored as ONE jsonb column matching
-- the TypeScript type in services/archetype-miner/src/types.ts exactly,
-- alongside a handful of DENORMALIZED plain columns for the filtering/
-- joining this service's own API actually needs (question_id, run_id,
-- education_context, status, confidence). Same reasoning
-- chapter_document_chunks (0024_chapter_documents_rag.sql) already applies
-- to board_id/grade_id/subject_id/medium: denormalize what queries filter
-- on, keep the rest as the real nested payload.
--
-- education_context (see EducationContext in types.ts) is stored as jsonb
-- on every stage table, not normalized into its own table: it's a small,
-- append-only-in-practice classification object (education_stage,
-- grade_or_year, curriculum_source, subject_or_course, program_or_stream),
-- and every query that scopes by it needs the whole object together
-- anyway (Stage 2 clustering and the level-appropriateness split rule both
-- key off the full tuple at once, never one field of it alone).

create extension if not exists vector;

-- One row per submitted batch (a set of raw papers, or pre-segmented
-- questions, for one education_context scope) -- tracks pipeline progress
-- across all 5 stages so services/archetype-miner's API can report status
-- without holding run state in memory (the service itself may restart
-- mid-run; this table is the source of truth for where a run actually is).
create table public.archetype_pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  education_context jsonb not null,
  -- 'raw_papers': Stage 0 (Segmenter) runs first. 'pre_segmented': caller
  -- already supplied SegmentedQuestion-shaped records (e.g. a corpus
  -- that's already been through segmentation once), so Stage 0 is skipped
  -- for this run.
  input_kind text not null check (input_kind in ('raw_papers', 'pre_segmented')),
  status text not null default 'pending' check (
    status in ('pending', 'segmenting', 'analyzing', 'embedding', 'clustering', 'mining', 'critiquing', 'completed', 'failed')
  ),
  -- Running counts per stage as the pipeline progresses (e.g.
  -- {"segmented": 142, "analyzed": 142, "clusters": 18, "archetypes": 23,
  -- "review_queue": 4}) -- polled by the submitting caller instead of
  -- needing a live connection to the run.
  stats jsonb not null default '{}'::jsonb,
  error text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index archetype_pipeline_runs_status_idx on public.archetype_pipeline_runs (status);

-- Stage 0 output / Stage 1 input. question_id is the spec's own stable
-- human-readable id (e.g. "CBSE-MATH-2019-SET1-Q17-i"), not a surrogate
-- uuid -- every downstream table keys off it directly, matching how the
-- source doc's own schemas cross-reference records.
create table public.archetype_segmented_questions (
  question_id text primary key,
  run_id uuid not null references public.archetype_pipeline_runs (id) on delete cascade,
  parent_question_id text references public.archetype_segmented_questions (question_id) on delete set null,
  education_context jsonb not null,
  -- Full SegmentedQuestion object (paper, marks, raw_text, cleaned_text,
  -- has_diagram, has_internal_choice, extraction_confidence,
  -- extraction_notes) -- see the migration-level comment above.
  question jsonb not null,
  created_at timestamptz not null default now()
);

create index archetype_segmented_questions_run_idx on public.archetype_segmented_questions (run_id);
create index archetype_segmented_questions_parent_idx on public.archetype_segmented_questions (parent_question_id);

-- Stage 1 output / clustering + Stage 2 input.
create table public.archetype_question_signatures (
  question_id text primary key references public.archetype_segmented_questions (question_id) on delete cascade,
  run_id uuid not null references public.archetype_pipeline_runs (id) on delete cascade,
  education_context jsonb not null,
  -- Full QuestionSignature object (curriculum, learning_objective, skills,
  -- reasoning_pattern, abstract_structure, format, context,
  -- cognitive_level, reasoning_direction, difficulty(_rationale)(_reference_frame),
  -- confidence, flags).
  signature jsonb not null,
  -- Denormalized from signature.confidence.overall -- what the review-queue
  -- population step (source: 'stage1_low_confidence') and any future admin
  -- filtering both need to query on directly, without unpacking jsonb on
  -- every row.
  confidence_overall numeric,
  created_at timestamptz not null default now()
);

create index archetype_question_signatures_run_idx on public.archetype_question_signatures (run_id);
create index archetype_question_signatures_confidence_idx on public.archetype_question_signatures (confidence_overall);

-- One embedding per signature, over the ClusterInput.embedding_basis text
-- (learning_objective + reasoning_pattern + abstract_structure) -- the
-- clustering step (services/archetype-miner/src/clustering.ts) reads these
-- back, scoped to one education_context at a time, to group signatures
-- before Stage 2 ever runs. Same model/dimension the rest of this app
-- already standardized on for embeddings (voyage-4, 1024-dim -- see
-- 0024_chapter_documents_rag.sql's own comment on why Voyage specifically).
create table public.archetype_question_embeddings (
  question_id text primary key references public.archetype_question_signatures (question_id) on delete cascade,
  run_id uuid not null references public.archetype_pipeline_runs (id) on delete cascade,
  education_context jsonb not null,
  embedding vector(1024) not null,
  created_at timestamptz not null default now()
);

create index archetype_question_embeddings_run_idx on public.archetype_question_embeddings (run_id);
create index archetype_question_embeddings_embedding_idx
  on public.archetype_question_embeddings using hnsw (embedding vector_cosine_ops);

-- Persisted ClusterInput groupings -- kept (not just held in memory during
-- a run) so a completed run's clustering is inspectable/debuggable after
-- the fact, and so Stage 2's cross-cluster split check
-- (nearest_neighbor_clusters) has stable cluster_ids to reference.
create table public.archetype_clusters (
  cluster_id text primary key,
  run_id uuid not null references public.archetype_pipeline_runs (id) on delete cascade,
  education_context jsonb not null,
  member_question_ids jsonb not null,
  -- {intra_cluster_cohesion, nearest_neighbor_clusters} -- see ClusterInput
  -- in types.ts.
  diagnostics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index archetype_clusters_run_idx on public.archetype_clusters (run_id);

-- Stage 2 output / Stage 3 input+output / the final catalogue. A single
-- row is reused across both stages (Stage 2 inserts status:'candidate',
-- Stage 3 updates the same row in place to status:'reviewed' plus its
-- critic_* fields) rather than a separate "reviewed" table, since it's the
-- same archetype_id identity throughout -- only its lifecycle status
-- changes, matching the source doc's own Archetype schema (one object
-- carries mining_confidence AND critic_decision as it moves through
-- candidate -> reviewed -> final).
create table public.archetypes (
  archetype_id text primary key,
  run_id uuid not null references public.archetype_pipeline_runs (id) on delete cascade,
  education_context jsonb not null,
  -- Full Archetype object (name, concept, learning_objective,
  -- invariant_reasoning_structure, variations, supporting_question_ids,
  -- stats incl. v2's grade_or_year_distribution, generator_usable(_rationale),
  -- mining_confidence, status, critic_decision/_rationale/_evidence,
  -- merge_target_id, split_result_ids).
  archetype jsonb not null,
  -- Denormalized from archetype.status / .critic_decision / .mining_confidence
  -- -- what the catalogue-browsing API and review-queue population both
  -- filter/sort on directly.
  status text not null default 'candidate' check (status in ('candidate', 'reviewed', 'final')),
  critic_decision text check (
    critic_decision in ('KEEP', 'MERGE', 'SPLIT', 'REVISE', 'REVIEW', 'ADD', 'REMOVE')
  ),
  mining_confidence numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index archetypes_run_idx on public.archetypes (run_id);
create index archetypes_status_idx on public.archetypes (status);
create index archetypes_education_context_idx on public.archetypes using gin (education_context);

-- The human review queue (design doc section 6) -- the defined destination
-- for every "I'm not sure" state: a Stage 1 signature below the confidence
-- threshold, a Stage 2 cluster flagged ambiguous/incomplete, or every
-- Stage 3 critic_decision:'REVIEW'. Never a dead end -- source + reference_id
-- always point back to the exact signature/archetype row a human needs to
-- look at.
create table public.archetype_review_queue (
  queue_item_id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.archetype_pipeline_runs (id) on delete cascade,
  source text not null check (
    source in ('stage1_low_confidence', 'stage2_ambiguous_cluster', 'stage3_review_flag')
  ),
  -- A question_id (archetype_segmented_questions) or archetype_id
  -- (archetypes) -- which one depends on `source`, so this is deliberately
  -- not a foreign key to either single table.
  reference_id text not null,
  reason text not null,
  confidence numeric,
  status text not null default 'pending' check (status in ('pending', 'resolved')),
  resolution text,
  resolved_by uuid references auth.users (id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index archetype_review_queue_run_idx on public.archetype_review_queue (run_id);
create index archetype_review_queue_status_idx on public.archetype_review_queue (status);

-- ---------------------------------------------------------------------------
-- RLS: same posture as chat_events/broadcasts -- every row here originates
-- from services/archetype-miner's own service-role key, never a client
-- session, so there is no ordinary-session insert/update policy on most of
-- these. archetype_review_queue is the one exception: an admin needs to be
-- able to resolve a queued item (mark it 'resolved' with their own
-- resolution) directly, the same "admin can write" pattern
-- student_usage_limits already uses -- everything else in this feature is
-- read-only from the admin UI's perspective, at least until there's a real
-- edit workflow for the mined catalogue itself.
-- ---------------------------------------------------------------------------

alter table public.archetype_pipeline_runs enable row level security;
alter table public.archetype_segmented_questions enable row level security;
alter table public.archetype_question_signatures enable row level security;
alter table public.archetype_question_embeddings enable row level security;
alter table public.archetype_clusters enable row level security;
alter table public.archetypes enable row level security;
alter table public.archetype_review_queue enable row level security;

create policy "archetype_pipeline_runs: admin can read" on public.archetype_pipeline_runs
  for select using (public.is_admin());
create policy "archetype_segmented_questions: admin can read" on public.archetype_segmented_questions
  for select using (public.is_admin());
create policy "archetype_question_signatures: admin can read" on public.archetype_question_signatures
  for select using (public.is_admin());
create policy "archetype_question_embeddings: admin can read" on public.archetype_question_embeddings
  for select using (public.is_admin());
create policy "archetype_clusters: admin can read" on public.archetype_clusters
  for select using (public.is_admin());
create policy "archetypes: admin can read" on public.archetypes
  for select using (public.is_admin());

create policy "archetype_review_queue: admin can read" on public.archetype_review_queue
  for select using (public.is_admin());
create policy "archetype_review_queue: admin can resolve" on public.archetype_review_queue
  for update using (public.is_admin()) with check (public.is_admin());
