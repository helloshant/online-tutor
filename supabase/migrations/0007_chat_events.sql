-- Observability: one row per student/staff question, whatever stage of the
-- answer pipeline served it. Written exclusively by the new
-- services/observability microservice (service-role key), which the
-- orchestrator reports to after every /v1/chat request -- never inserted by
-- the web app or a client directly.
--
-- A single unified table (rather than separate per-source tables) makes the
-- two required admin views simple queries/filters over one place, and keeps
-- a natural join from an "llm" row's board/grade/subject over to a
-- "database" row that served the same question later:
--   - Consolidated LLM usage & cost: filter source = 'llm', aggregate by user.
--   - Consolidated DB hit count: filter source = 'database', count(*).
--   - Per-query drilldown: any individual row, with its question + tokens +
--     cost + timestamp.
--
-- Token/cost columns are populated only for source = 'llm' -- a cache or
-- database hit costs nothing and consumes no tokens, so those columns stay
-- null rather than being recorded as zero (zero would misleadingly claim a
-- known-free answer rather than "not applicable here").

create table public.chat_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  mode text not null check (mode in ('student', 'staff')),
  -- Null for staff mode (unrestricted, no board/grade/syllabus).
  board_id uuid references public.boards (id) on delete set null,
  grade_id uuid references public.grades (id) on delete set null,
  subject_id uuid not null references public.subjects (id) on delete cascade,
  medium text check (medium in ('English', 'Hindi', 'Bengali')),
  question text not null,
  source text not null check (source in ('cache', 'database', 'llm', 'rejected')),
  -- Populated for source = 'llm' only.
  provider text,
  model text,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  cost_usd numeric(12, 6),
  -- Populated for source = 'database' only -- which answer-bank entry served
  -- this hit, so a "database" event can be drilled into the exact content
  -- that was reused.
  answer_bank_id uuid references public.answered_questions (id) on delete set null,
  latency_ms integer,
  created_at timestamptz not null default now()
);

create index chat_events_user_created_idx on public.chat_events (user_id, created_at desc);
create index chat_events_source_idx on public.chat_events (source);
create index chat_events_created_idx on public.chat_events (created_at desc);

alter table public.chat_events enable row level security;

-- Admin-only read, same pattern as the syllabus catalog tables and
-- answered_questions (RLS + is_admin()) so /admin/observability can query
-- through the ordinary session. No insert/update/delete policy -- every row
-- originates from the observability service's service-role key, never a
-- client.
create policy "chat_events: admin can read all" on public.chat_events
  for select using (public.is_admin());
