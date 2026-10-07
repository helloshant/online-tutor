-- Persists the exact raw LLM output whenever on-demand topic-exercise
-- generation (/v1/topic-exercises/generate) produces something that
-- doesn't parse into a usable Q:/A: exercise, even after the one retry --
-- previously this was only ever console.error'd from the orchestrator
-- service, which means diagnosing a student-reported "Could not generate
-- a question right now" required direct access to that service's own
-- runtime logs. Service-role only, same posture as every other backend-
-- only table this session has added (login_lockouts, student_wallets,
-- etc.) -- this is a debugging aid for staff, nothing a student ever
-- reads or writes.
create table public.exercise_generation_failures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  board_id uuid references public.boards(id) on delete set null,
  grade_id uuid references public.grades(id) on delete set null,
  subject_id uuid references public.subjects(id) on delete set null,
  chapter text not null,
  topic text not null,
  -- The archetype pattern's own label and ids, when generation was
  -- archetype-grounded (always true for this route) -- kept as plain text
  -- rather than foreign keys, since archetype_miner rows can be pruned
  -- independently and this table's only job is to explain a past failure,
  -- not stay referentially in sync with them.
  pattern_name text,
  archetype_id text,
  archetype_run_id text,
  requested_type text,
  requested_difficulty text,
  provider text,
  raw_output text not null,
  created_at timestamptz not null default now()
);

alter table public.exercise_generation_failures enable row level security;
