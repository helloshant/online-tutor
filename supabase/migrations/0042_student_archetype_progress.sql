-- Tracks, per student, which mined archetype (reasoning pattern) they've
-- been shown a practice question for -- the data layer under a visible
-- "N of M known patterns practiced" chapter/topic view (the TopicList
-- sidebar/tab), not just the admin-facing archetype catalogue.
--
-- Deliberately records "shown a generated exercise following this
-- pattern," not "correctly answered" -- /v1/topic-exercises has no
-- answer-submission/grading step at all (the worked solution is shown
-- alongside the question immediately, for self-study), so there is no
-- signal anywhere in this app for actual mastery to record here. Never
-- imply assessed correctness in anything built on top of this table.
--
-- Written only by the orchestrator service's own service-role connection,
-- right after it generates an archetype-grounded exercise batch (see
-- services/orchestrator/src/archetypeExercises.ts) -- same "no self-write
-- policy, only a read-own-row policy" posture as student_usage_limits
-- (0037_student_token_usage_limits.sql), for the same reason: nothing
-- about a student's own progress record should be writable from their own
-- logged-in session.
--
-- (run_id, archetype_id) rather than a bare archetype_id -- archetype_id
-- is only unique WITHIN a run (0041_archetype_miner_run_scoped_ids.sql).
-- chapter/topic/board_id/grade_id/subject_id/medium are denormalized
-- (rather than re-joined through archetypes/archetype_question_signatures
-- on every read) so the student-facing progress query -- run once per
-- subject, for every chapter/topic in it -- stays a single indexed lookup
-- instead of a repeated soft chapter/topic match per row.
create table public.student_archetype_progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  run_id uuid not null,
  archetype_id text not null,
  board_id uuid not null references public.boards (id) on delete cascade,
  grade_id uuid not null references public.grades (id) on delete cascade,
  subject_id uuid not null references public.subjects (id) on delete cascade,
  medium text not null,
  chapter text not null,
  topic text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  times_seen integer not null default 1,
  unique (user_id, run_id, archetype_id)
);

create index student_archetype_progress_user_scope_idx
  on public.student_archetype_progress (user_id, board_id, grade_id, subject_id, medium);

alter table public.student_archetype_progress enable row level security;

create policy "student_archetype_progress: user can read own rows"
  on public.student_archetype_progress for select
  using (user_id = auth.uid());

create policy "student_archetype_progress: admin can read all rows"
  on public.student_archetype_progress for select
  using (public.is_admin());
