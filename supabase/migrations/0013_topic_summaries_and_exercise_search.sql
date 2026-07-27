-- ---------------------------------------------------------------------------
-- Replaces the hand-curated exercises feature (0010, dropped in 0012) with
-- two LLM-backed features, both owned entirely by the orchestrator service
-- (service-role key) -- the web app never reads or writes either directly,
-- only through orchestrator-proxied API routes, same reasoning as
-- answered_questions in 0005_answer_bank.sql.
-- ---------------------------------------------------------------------------

-- One generated summary per topic. Locked down with RLS enabled and zero
-- policies -- there's no admin-review UI for these (unlike the answer bank),
-- so there's no reason for anything but the service-role key to touch this
-- table at all.
create table public.topic_summaries (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null unique references public.syllabus_topics (id) on delete cascade,
  summary text not null,
  created_at timestamptz not null default now()
);

alter table public.topic_summaries enable row level security;

-- "Relevant exercises" search: unlike search_answer_bank (used by the chat
-- pipeline, which wants the single best match for one specific question),
-- this wants several ranked matches for a *topic* (chapter+topic name as the
-- query) and needs the question text back too, not just the answer, since
-- the student is shown a list of exercises rather than a single reply. Kept
-- as its own function rather than changing search_answer_bank's signature,
-- so the existing chat pipeline is untouched.
create function public.search_topic_exercises(
  p_board_id uuid,
  p_grade_id uuid,
  p_subject_id uuid,
  p_medium text,
  p_query text,
  p_min_rank real default 0.1,
  p_limit integer default 5
)
returns table (id uuid, question text, answer text, rank real)
language sql
stable
security definer set search_path = public
as $$
  select id, question, answer, rank
  from (
    select id, question, answer,
      ts_rank(question_tsv, websearch_to_tsquery('simple', p_query)) as rank
    from public.answered_questions
    where board_id = p_board_id
      and grade_id = p_grade_id
      and subject_id = p_subject_id
      and medium = p_medium
      and validation_status in ('auto_approved', 'admin_approved')
      and question_tsv @@ websearch_to_tsquery('simple', p_query)
  ) ranked
  where rank >= p_min_rank
  order by rank desc
  limit p_limit;
$$;

revoke execute on function public.search_topic_exercises(uuid, uuid, uuid, text, text, real, integer) from public;
grant execute on function public.search_topic_exercises(uuid, uuid, uuid, text, text, real, integer) to service_role;
