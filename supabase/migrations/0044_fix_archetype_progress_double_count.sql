-- Fixes a real bug in record_archetype_progress (0043) caught during
-- review, before the orchestrator code that would have triggered it ever
-- shipped: times_seen incremented unconditionally on EVERY call, but a
-- single exposure to an archetype now produces TWO calls -- one "shown"
-- event at exercise generation (p_result null), and, if the student goes
-- on to submit an answer, one "graded" event at grading (p_result set) --
-- for the exact same exercise instance. Both incrementing times_seen
-- would double-count a single exposure as two.
--
-- Fix: only the "shown" call (p_result is null) increments times_seen.
-- The "graded" call updates times_correct/times_incorrect/last_result
-- without touching times_seen again -- it's reporting the OUTCOME of an
-- exposure already counted, not a new one.
create or replace function public.record_archetype_progress(
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
    times_seen = public.student_archetype_progress.times_seen
      + (case when p_result is null then 1 else 0 end),
    times_correct = public.student_archetype_progress.times_correct
      + (case when p_result = 'correct' then 1 else 0 end),
    times_incorrect = public.student_archetype_progress.times_incorrect
      + (case when p_result = 'incorrect' then 1 else 0 end),
    last_result = coalesce(p_result, public.student_archetype_progress.last_result);
end;
$$;
