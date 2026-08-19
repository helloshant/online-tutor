-- Extends match_chapter_chunks (0024_chapter_documents_rag.sql) to also
-- return each match's document title and chapter/topic name, not just its
-- content -- needed for the new student-facing "Search chapter notes"
-- feature in the Practice panel (services/orchestrator/src/chapterRag.ts's
-- searchChapterNotes), which shows each result labeled by where it came
-- from, unlike the chat pipeline's use of this same function (stage 4 of
-- /v1/chat), which only ever needed bare excerpt text to weave into a
-- prompt.
--
-- Changing the OUT parameters (the returned columns) means Postgres won't
-- allow a plain `create or replace` here (42P13: "cannot change return type
-- of existing function") -- an explicit drop first is required. The
-- revoke/grant pair below is re-applied after recreating it as cheap
-- insurance (see 0024's comment on this project's default privileges
-- having granted EXECUTE somewhere a bare `revoke ... from public` didn't
-- expect) since a drop+recreate, unlike create-or-replace, does *not*
-- preserve the previous grants.
drop function if exists public.match_chapter_chunks(uuid, uuid, uuid, text, vector, uuid, integer);

create function public.match_chapter_chunks(
  p_board_id uuid,
  p_grade_id uuid,
  p_subject_id uuid,
  p_medium text,
  p_query_embedding vector(1024),
  p_topic_id uuid default null,
  p_match_count integer default 5
)
returns table (
  id uuid,
  document_id uuid,
  title text,
  chapter text,
  topic text,
  content text,
  similarity real
)
language sql
stable
security definer set search_path = public
as $$
  select
    c.id,
    c.document_id,
    d.title,
    t.chapter,
    t.topic,
    c.content,
    (1 - (c.embedding <=> p_query_embedding))::real as similarity
  from public.chapter_document_chunks c
  join public.chapter_documents d on d.id = c.document_id
  join public.syllabus_topics t on t.id = c.topic_id
  where c.board_id = p_board_id
    and c.grade_id = p_grade_id
    and c.subject_id = p_subject_id
    and c.medium = p_medium
    and (p_topic_id is null or c.topic_id = p_topic_id)
  order by c.embedding <=> p_query_embedding
  limit p_match_count;
$$;

revoke execute on function public.match_chapter_chunks(uuid, uuid, uuid, text, vector, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.match_chapter_chunks(uuid, uuid, uuid, text, vector, uuid, integer) to service_role;
