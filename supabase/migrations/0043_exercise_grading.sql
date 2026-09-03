-- Real mastery tracking: a student submits their OWN answer to a generated
-- exercise before seeing the worked solution, an LLM grades it, and the
-- result feeds student_archetype_progress -- upgrading it from "shown a
-- question for this pattern" (0042) to "attempted it, here's how often
-- they actually got it right."

-- 1. Archetype attribution lives on the exercise ROW itself (not just per
-- generation-call) -- an exercise generated once can be re-served to a
-- LATER student from the answer bank (see findRelevantExercises /
-- search_topic_exercises below) without regenerating, and that later
-- student's own attempt still needs to credit the right archetype.
-- Nullable: most exercises still aren't archetype-grounded (nothing mined
-- for their chapter/topic yet, or they predate this column).
alter table public.answered_questions
  add column archetype_run_id uuid,
  add column archetype_id text;

-- 2. search_topic_exercises' RETURNS TABLE shape has to be dropped and
-- recreated (not just CREATE OR REPLACE'd -- Postgres refuses to change
-- an existing function's return type in place) to carry the new columns
-- through the "already banked, reused for a different/later student"
-- path, not just freshly generated exercises.
drop function if exists public.search_topic_exercises(uuid, uuid, uuid, text, uuid, integer);

create function public.search_topic_exercises(
  p_board_id uuid,
  p_grade_id uuid,
  p_subject_id uuid,
  p_medium text,
  p_topic_id uuid,
  p_limit integer default 5
)
returns table (id uuid, question text, answer text, archetype_run_id uuid, archetype_id text)
language sql
stable
security definer set search_path = public
as $$
  select id, question, answer, archetype_run_id, archetype_id
  from public.answered_questions
  where board_id = p_board_id
    and grade_id = p_grade_id
    and subject_id = p_subject_id
    and medium = p_medium
    and topic_id = p_topic_id
    and validation_status <> 'rejected'
  order by created_at asc
  limit p_limit;
$$;

revoke execute on function public.search_topic_exercises(uuid, uuid, uuid, text, uuid, integer) from public;
grant execute on function public.search_topic_exercises(uuid, uuid, uuid, text, uuid, integer) to service_role;

-- 3. student_archetype_progress gains real outcome tracking.
alter table public.student_archetype_progress
  add column times_correct integer not null default 0,
  add column times_incorrect integer not null default 0,
  add column last_result text
    check (last_result is null or last_result in ('correct', 'partially_correct', 'incorrect'));

-- 4. A proper atomic upsert -- the plain PostgREST upsert 0042 originally
-- used could set an initial value on insert, but could never actually
-- INCREMENT times_seen/times_correct/times_incorrect on a repeat call
-- (every column not in the payload is simply left untouched on conflict,
-- not incremented -- PostgREST has no way to express "+1" in a plain
-- upsert). Called two ways: p_result null for a plain "shown" event (the
-- exercise-generation path, unchanged behavior from 0042's own intent,
-- now actually incrementing times_seen); p_result set for a graded
-- attempt (increments times_correct/times_incorrect and updates
-- last_result). Fine either way whether the row already exists or not --
-- ON CONFLICT DO UPDATE reads the row's OWN current values via the table
-- name (not `excluded`), so this is correct however many times it's
-- called for the same (user, run, archetype).
create function public.record_archetype_progress(
  p_user_id uuid,
  p_run_id uuid,
  p_archetype_id text,
  p_board_id uuid,
  p_grade_id uuid,
  p_subject_id uuid,
  p_medium text,
  p_chapter text,
  p_topic text,
  p_result text default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if p_result is not null and p_result not in ('correct', 'partially_correct', 'incorrect') then
    raise exception 'invalid p_result: %', p_result;
  end if;

  insert into public.student_archetype_progress (
    user_id, run_id, archetype_id, board_id, grade_id, subject_id, medium, chapter, topic,
    times_seen, times_correct, times_incorrect, last_result
  ) values (
    p_user_id, p_run_id, p_archetype_id, p_board_id, p_grade_id, p_subject_id, p_medium, p_chapter, p_topic,
    1,
    case when p_result = 'correct' then 1 else 0 end,
    case when p_result = 'incorrect' then 1 else 0 end,
    p_result
  )
  on conflict (user_id, run_id, archetype_id) do update set
    last_seen_at = now(),
    times_seen = public.student_archetype_progress.times_seen + 1,
    times_correct = public.student_archetype_progress.times_correct
      + (case when p_result = 'correct' then 1 else 0 end),
    times_incorrect = public.student_archetype_progress.times_incorrect
      + (case when p_result = 'incorrect' then 1 else 0 end),
    last_result = coalesce(p_result, public.student_archetype_progress.last_result);
end;
$$;

revoke execute on function public.record_archetype_progress(uuid, uuid, text, uuid, uuid, uuid, text, text, text, text) from public;
grant execute on function public.record_archetype_progress(uuid, uuid, text, uuid, uuid, uuid, text, text, text, text) to service_role;
