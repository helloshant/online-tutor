-- Adds semantic (embedding) search as a SECOND pass over the answer bank,
-- layered on top of the existing full-text search (search_answer_bank,
-- 0005_answer_bank.sql), not a replacement for it. That migration's own
-- comment explains why FTS was chosen originally: "a topically-similar-
-- but-substantively-different question (e.g. 'derivative of x^2' vs
-- 'integral of x^2') must never confidently return the wrong cached
-- answer, which is a real risk with embedding similarity but not with
-- keyword/lexical matching." That risk is real and still applies here --
-- this migration doesn't remove the FTS path, it adds semantic matching as
-- a fallback the orchestrator only tries on an FTS miss, and only serves a
-- match from at a conservative similarity threshold (see answerBank.ts's
-- own comment on why that threshold is stricter than chapterRag.ts's).
--
-- Same embedding pattern as chapter_document_chunks
-- (0024_chapter_documents_rag.sql): Voyage voyage-4, 1024 dimensions, HNSW
-- + vector_cosine_ops (pre-normalized unit-length embeddings, so cosine
-- similarity and dot product coincide). See that migration's own comment
-- for the full reasoning, not repeated here.

alter table public.answered_questions
  add column embedding vector(1024);

-- Partial: most existing rows (the 1065 exercise-generation ones, matched
-- by exact topic_id, never FTS/semantic text matching at all) will never
-- have an embedding and don't need to be in this index -- see
-- answerBank.ts's own comment on why only topic_id-null (chat-originated)
-- rows are backfilled.
create index answered_questions_embedding_idx
  on public.answered_questions using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

-- Semantic counterpart to search_answer_bank -- same scope filter (board/
-- grade/subject/medium, applied as a plain equality check before the ANN
-- search runs, same as match_chapter_chunks), but ranked by embedding
-- cosine similarity instead of ts_rank. p_min_similarity has no default on
-- purpose (unlike search_answer_bank's p_min_rank) -- the caller's
-- threshold choice here directly controls how often a student risks being
-- confidently served the wrong cached answer, which deserves an explicit
-- value at every call site, not a function-level default someone could
-- forget they're relying on.
create function public.match_answer_bank(
  p_board_id uuid,
  p_grade_id uuid,
  p_subject_id uuid,
  p_medium text,
  p_query_embedding vector(1024),
  p_min_similarity real
)
returns table (id uuid, answer text, similarity real)
language sql
stable
security definer set search_path = public
as $$
  select id, answer, similarity
  from (
    select id, answer, (1 - (embedding <=> p_query_embedding))::real as similarity
    from public.answered_questions
    where board_id = p_board_id
      and grade_id = p_grade_id
      and subject_id = p_subject_id
      and medium = p_medium
      and embedding is not null
  ) ranked
  where similarity >= p_min_similarity
  order by similarity desc
  limit 1;
$$;

-- Same "explicitly named anon/authenticated" fix 0024's own comment
-- documents for match_chapter_chunks -- this project's default privileges
-- grant EXECUTE on a newly created function directly to anon/authenticated,
-- which "revoke ... from public" alone doesn't undo.
revoke execute on function public.match_answer_bank(uuid, uuid, uuid, text, vector, real)
  from public, anon, authenticated;
grant execute on function public.match_answer_bank(uuid, uuid, uuid, text, vector, real) to service_role;
