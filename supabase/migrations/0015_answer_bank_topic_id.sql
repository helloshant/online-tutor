-- Answer-bank entries created by the topic-exercises generation flow had no
-- way to record which syllabus topic they came from -- only board/grade/
-- subject/medium, which every topic in a subject shares. search_topic_exercises
-- (0013) worked around this by full-text-ranking the topic's "<chapter>
-- <topic>" name against each stored question, but that's only an
-- approximation: two topics with overlapping vocabulary can bleed into each
-- other's "Relevant Exercises" results, and an exercise can fail to
-- resurface for its own topic if the wording drifts. This adds an explicit,
-- nullable topic_id (nullable because the main /v1/chat pipeline has no
-- topic concept at all -- only exercise generation does) so exercise
-- retrieval can be an exact match instead of a fuzzy one.

alter table public.answered_questions
  add column topic_id uuid references public.syllabus_topics (id) on delete set null;

create index answered_questions_topic_idx on public.answered_questions (topic_id);

-- Replaces the 0013 version: exact topic_id match instead of full-text
-- ranking against the chapter+topic name. board/grade/subject/medium are
-- kept as belt-and-suspenders scoping -- a topic_id should already imply
-- these, but this guards against a caller passing a mismatched scope.
-- Existing rows created before this migration have topic_id = null and
-- will no longer surface here (they remain in the table and stay reachable
-- through the chat pipeline's search_answer_bank) -- a fresh "Relevant
-- Exercises" click on their topic will simply regenerate.
drop function if exists public.search_topic_exercises(uuid, uuid, uuid, text, text, real, integer);

create function public.search_topic_exercises(
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
    and validation_status in ('auto_approved', 'admin_approved')
  order by created_at asc
  limit p_limit;
$$;

revoke execute on function public.search_topic_exercises(uuid, uuid, uuid, text, uuid, integer) from public;
grant execute on function public.search_topic_exercises(uuid, uuid, uuid, text, uuid, integer) to service_role;
