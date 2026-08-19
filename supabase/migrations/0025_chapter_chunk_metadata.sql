-- ---------------------------------------------------------------------------
-- Supports importing pre-chunked, pre-structured chapter content (an admin
-- can prepare a JSON file offline -- e.g. via an LLM-assisted authoring
-- pass -- with each chunk already split along natural boundaries: chapter
-- overview, plot summary, characters, setting, themes, one entry per
-- vocabulary word, grammar/composition topics, exercise topics) instead of
-- always pasting one long block of text for this app's own paragraph-based
-- chunker to re-split naively.
--
-- Two new nullable columns on chapter_document_chunks, populated only by
-- this JSON import path (src/app/admin/chapter-notes/import-chunks-form.tsx
-- -> POST /v1/chapter-documents/import-chunks -> chapterDocuments.ts's
-- embedAndStorePrechunkedDocument) -- a chunk created by the original
-- single-document paste-and-auto-chunk path leaves both null, which every
-- reader here treats as "no extra structure/citation available," not an
-- error:
--   - field_type: what kind of content this chunk is (e.g. "summary",
--     "vocabulary", "themes") -- surfaced to the LLM as a label prefix on
--     each reference chunk (see prompts.ts) so it knows a given excerpt is,
--     say, a vocabulary definition rather than plot summary, and to support
--     showing/filtering by it in a future admin UI.
--   - citation: the exact, admin-authored citation string for this specific
--     chunk (e.g. book title, chapter, author, page range) -- passed
--     straight through to the LLM per-chunk so it can cite precisely rather
--     than only being able to name the chapter/topic the chunk's parent
--     document belongs to.
--
-- Note this is unrelated to the earlier, since-reverted widening of
-- match_chapter_chunks's *document*-level columns (document_id/title/
-- chapter/topic) for the standalone student-search feature -- this instead
-- adds *chunk*-level metadata used only by the chat pipeline's prompt
-- augmentation (server.ts stage 4), which was never reverted.
-- ---------------------------------------------------------------------------

alter table public.chapter_document_chunks
  add column field_type text,
  add column citation text;

-- Return-type change means Postgres won't allow a plain `create or replace`
-- here (42P13: cannot change return type of existing function) -- see
-- 0025_chapter_notes_search.sql's now-reverted equivalent note. Requires an
-- explicit drop, which does not preserve prior grants, so the revoke/grant
-- pair is reapplied below.
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
returns table (id uuid, document_id uuid, content text, field_type text, citation text, similarity real)
language sql
stable
security definer set search_path = public
as $$
  select id, document_id, content, field_type, citation,
    (1 - (embedding <=> p_query_embedding))::real as similarity
  from public.chapter_document_chunks
  where board_id = p_board_id
    and grade_id = p_grade_id
    and subject_id = p_subject_id
    and medium = p_medium
    and (p_topic_id is null or topic_id = p_topic_id)
  order by embedding <=> p_query_embedding
  limit p_match_count;
$$;

revoke execute on function public.match_chapter_chunks(uuid, uuid, uuid, text, vector, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.match_chapter_chunks(uuid, uuid, uuid, text, vector, uuid, integer) to service_role;
