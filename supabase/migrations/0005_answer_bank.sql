-- L2 of the orchestrator's answer pipeline: a durable, shared knowledge base
-- of previously-answered questions, scoped by board/grade/subject/medium and
-- searched with Postgres full-text search (BM25-style ranking via ts_rank)
-- before ever falling back to the LLM. Deliberately relational/FTS, not
-- vector/semantic search -- a topically-similar-but-substantively-different
-- question (e.g. "derivative of x^2" vs "integral of x^2") must never
-- confidently return the wrong cached answer, which is a real risk with
-- embedding similarity but not with keyword/lexical matching.
--
-- This table is a backend implementation detail of the orchestrator service
-- only: RLS is enabled with zero policies, so ordinary users/admins/anon can
-- never read or write it through the client-facing API, only the
-- service-role key (used exclusively by services/orchestrator) can, and even
-- then only through the RPCs below (execute revoked from public).

create table public.answered_questions (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.boards (id) on delete cascade,
  grade_id uuid not null references public.grades (id) on delete cascade,
  subject_id uuid not null references public.subjects (id) on delete cascade,
  medium text not null check (medium in ('English', 'Hindi', 'Bengali')),
  question text not null,
  answer text not null,
  -- 'simple' config (lowercase + tokenize, no stemming) rather than
  -- 'english' -- this table also stores Hindi/Bengali questions, and English
  -- stemming rules would corrupt them.
  question_tsv tsvector generated always as (to_tsvector('simple', question)) stored,
  hit_count integer not null default 1,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create index answered_questions_scope_idx
  on public.answered_questions (board_id, grade_id, subject_id, medium);

create index answered_questions_tsv_idx
  on public.answered_questions using gin (question_tsv);

alter table public.answered_questions enable row level security;
-- No policies -- see comment above. Every access goes through the RPCs
-- below, which are themselves locked to service_role.

-- Returns the single best full-text match within scope, or no rows if
-- nothing clears p_min_rank -- callers should treat "no rows" as a miss and
-- fall through to the LLM rather than serving a weak/unreliable match.
create function public.search_answer_bank(
  p_board_id uuid,
  p_grade_id uuid,
  p_subject_id uuid,
  p_medium text,
  p_query text,
  p_min_rank real default 0.1
)
returns table (id uuid, answer text, rank real)
language sql
stable
security definer set search_path = public
as $$
  select id, answer, rank
  from (
    select id, answer, ts_rank(question_tsv, websearch_to_tsquery('simple', p_query)) as rank
    from public.answered_questions
    where board_id = p_board_id
      and grade_id = p_grade_id
      and subject_id = p_subject_id
      and medium = p_medium
      and question_tsv @@ websearch_to_tsquery('simple', p_query)
  ) ranked
  where rank >= p_min_rank
  order by rank desc
  limit 1;
$$;

create function public.bump_answer_bank_hit(p_id uuid)
returns void
language sql
security definer set search_path = public
as $$
  update public.answered_questions
  set hit_count = hit_count + 1, last_used_at = now()
  where id = p_id;
$$;

revoke execute on function public.search_answer_bank(uuid, uuid, uuid, text, text, real) from public;
revoke execute on function public.bump_answer_bank_hit(uuid) from public;
grant execute on function public.search_answer_bank(uuid, uuid, uuid, text, text, real) to service_role;
grant execute on function public.bump_answer_bank_hit(uuid) to service_role;
