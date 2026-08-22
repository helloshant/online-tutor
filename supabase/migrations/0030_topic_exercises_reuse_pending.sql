-- ---------------------------------------------------------------------------
-- Real bug: "Relevant Exercises" was regenerating from the LLM on every
-- click for a lot of topics, instead of reusing what was already banked.
--
-- Root cause: search_topic_exercises (0015_answer_bank_topic_id.sql) only
-- counted a hit if validation_status was 'auto_approved' or
-- 'admin_approved' -- excluding 'pending_review'. But the *generation*
-- path in services/orchestrator/src/server.ts's /v1/topic-exercises
-- already shows every validation.store===true exercise straight to the
-- student regardless of status (see answerValidation.ts -- a
-- 'pending_review' exercise is just as visible to the student as an
-- 'auto_approved' one, the moment it's generated). Exercise *answers*
-- legitimately trip validateAnswerForStorage's
-- MIN_LENGTH_FOR_AUTO_APPROVAL (150 chars) far more often than an
-- ordinary chat explanation does -- a worked solution is often short and
-- to the point -- so a sizeable share of generated exercises land
-- 'pending_review' and, until this fix, could never be found again: the
-- next click's lookup excluded them, so it silently regenerated a fresh
-- (differently-worded) batch, itself likely to land 'pending_review'
-- again, every single time.
--
-- Fix: only exclude 'rejected' (an admin explicitly said this one is
-- wrong) -- everything else banked for this topic is exactly as reusable
-- as it already was servable on the click that generated it.
create or replace function public.search_topic_exercises(
  p_board_id uuid,
  p_grade_id uuid,
  p_subject_id uuid,
  p_medium text,
  p_topic_id uuid,
  p_limit integer default 5
)
returns table (id uuid, question text, answer text)
language sql
stable
security definer set search_path = public
as $$
  select id, question, answer
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
