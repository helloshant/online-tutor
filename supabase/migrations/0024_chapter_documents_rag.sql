-- ---------------------------------------------------------------------------
-- Detailed, admin-authored chapter content (e.g. a full summary of an
-- English-medium literature chapter) retrievable by *meaning*, not just
-- keyword overlap -- the answer bank's existing full-text search
-- (search_answer_bank/search_topic_exercises) is a poor fit for prose: a
-- paraphrased student question ("why was he upset") won't keyword-match
-- text that says "he was angry" the way it does for MCQ/formula content
-- where wording tends to overlap. This adds a proper retrieval-augmented-
-- generation (RAG) path: an admin pastes a detailed chapter summary, it
-- gets split into chunks and embedded (via Voyage AI -- Anthropic has no
-- first-party embedding model, and Voyage is Anthropic's own recommended
-- embeddings partner), and a student's live chat question is embedded the
-- same way and matched against those chunks by vector similarity.
--
-- Two tables, deliberately split:
--   - chapter_documents: the raw admin-authored text, one row per
--     document (a topic can have more than one -- e.g. "Chapter summary"
--     and "Character notes" as separate documents). This is the thing an
--     admin edits/deletes; same trust model as the answer bank's bulk
--     import (real, curated content, not LLM-generated).
--   - chapter_document_chunks: derived from the above -- split into
--     retrieval-sized pieces with an embedding vector each. Regenerated
--     wholesale (delete-then-reinsert for that document_id) whenever the
--     parent document is saved, never edited directly.
-- ---------------------------------------------------------------------------

create extension if not exists vector;

create table public.chapter_documents (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references public.syllabus_topics (id) on delete cascade,
  -- Distinguishes multiple documents on the same topic in the admin list
  -- (e.g. "Chapter summary" vs "Character notes") -- never shown to
  -- students, who only ever see retrieved chunk text woven into a chat
  -- reply, not this table directly.
  title text not null,
  content text not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index chapter_documents_topic_idx on public.chapter_documents (topic_id);

alter table public.chapter_documents enable row level security;

-- Same "backend-only table" posture as answered_questions
-- (0005_answer_bank.sql): RLS enabled, zero client-facing policies. The
-- admin panel (src/app/admin/chapter-notes) reads/writes this with the
-- service-role client, same as it already does for answered_questions --
-- there is no ordinary-session path to this table at all.

-- Chunked + embedded pieces of the documents above. board_id/grade_id/
-- subject_id/medium are denormalized straight from the parent topic (not
-- looked up via a join at query time) so the retrieval RPC below can filter
-- on plain equality before the vector search runs, the same reasoning
-- answered_questions stores board/grade/subject/medium directly rather than
-- deriving them from topic_id on every lookup.
--
-- 1024 dimensions matches Voyage's `voyage-4` model at its default output
-- size (voyage-4 also supports 256/512/2048 via Matryoshka truncation, but
-- this app always requests the default) -- see services/orchestrator/src/
-- voyageClient.ts. Changing embedding models later means re-embedding every
-- existing chunk, since vectors from different models aren't comparable.
create table public.chapter_document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.chapter_documents (id) on delete cascade,
  topic_id uuid not null references public.syllabus_topics (id) on delete cascade,
  board_id uuid not null references public.boards (id) on delete cascade,
  grade_id uuid not null references public.grades (id) on delete cascade,
  subject_id uuid not null references public.subjects (id) on delete cascade,
  medium text not null,
  -- Position within the source document -- not currently used for
  -- ordering retrieved results (those are ranked by similarity, not
  -- document order), but kept for debugging/re-chunking and so a future
  -- "show surrounding context" feature has it for free.
  chunk_index int not null,
  content text not null,
  embedding vector(1024) not null,
  created_at timestamptz not null default now()
);

create index chapter_document_chunks_document_idx on public.chapter_document_chunks (document_id);

-- Lets Postgres narrow to this board/grade/subject/medium's rows before
-- (or alongside) the vector search, rather than the ANN index having to
-- consider every chunk across every subject in the database.
create index chapter_document_chunks_scope_idx
  on public.chapter_document_chunks (board_id, grade_id, subject_id, medium);

-- HNSW over ivfflat: no training/list-count tuning needed as the table
-- grows, and better recall at comparable query speed for a table this size
-- (a school subject's worth of chapter notes, not millions of rows).
-- vector_cosine_ops matches Voyage embeddings being pre-normalized to unit
-- length (cosine similarity and dot product coincide -- see Voyage's own
-- embeddings guide), and is what match_chapter_chunks below queries with.
create index chapter_document_chunks_embedding_idx
  on public.chapter_document_chunks using hnsw (embedding vector_cosine_ops);

alter table public.chapter_document_chunks enable row level security;
-- Same posture as chapter_documents above: RLS enabled, zero policies --
-- only the orchestrator's service-role connection ever reads this table
-- (see services/orchestrator/src/chapterRag.ts), same as topic_summaries
-- (0013_topic_summaries_and_exercise_search.sql).

-- Semantic retrieval for the chat pipeline: given a student's question,
-- already embedded by the caller (the orchestrator, via Voyage), find the
-- chunks whose meaning is closest within this exact board/grade/subject/
-- medium scope. p_topic_id narrows to one chapter when known (unused by
-- the chat pipeline today, kept for a future "ask within this topic"
-- entry point); left null it searches the whole subject.
--
-- `<=>` is pgvector's cosine *distance* (0 = identical, 2 = opposite);
-- `1 - distance` converts it to a similarity score in the same "higher is
-- better" direction as search_answer_bank's ts_rank, so callers can apply
-- a min-similarity threshold the same way.
create function public.match_chapter_chunks(
  p_board_id uuid,
  p_grade_id uuid,
  p_subject_id uuid,
  p_medium text,
  p_query_embedding vector(1024),
  p_topic_id uuid default null,
  p_match_count integer default 5
)
returns table (id uuid, document_id uuid, content text, similarity real)
language sql
stable
security definer set search_path = public
as $$
  select id, document_id, content, (1 - (embedding <=> p_query_embedding))::real as similarity
  from public.chapter_document_chunks
  where board_id = p_board_id
    and grade_id = p_grade_id
    and subject_id = p_subject_id
    and medium = p_medium
    and (p_topic_id is null or topic_id = p_topic_id)
  order by embedding <=> p_query_embedding
  limit p_match_count;
$$;

-- Explicitly named anon/authenticated, not just PUBLIC -- unlike
-- search_answer_bank/search_topic_exercises (0005/0013), this project's
-- default privileges turned out to grant EXECUTE on a newly created
-- function directly to anon and authenticated (confirmed via pg_proc.proacl
-- after applying this migration), which "revoke ... from public" alone
-- does not undo -- PUBLIC is a distinct pseudo-role from either of them.
revoke execute on function public.match_chapter_chunks(uuid, uuid, uuid, text, vector, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.match_chapter_chunks(uuid, uuid, uuid, text, vector, uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- New admin page: "chapter_notes". Same grandfathering approach 0008 and
-- 0019 used when a new page was first introduced, so this doesn't silently
-- lock out an admin who could already reach every other page.
-- ---------------------------------------------------------------------------
alter table public.admin_page_permissions drop constraint admin_page_permissions_page_check;
alter table public.admin_page_permissions add constraint admin_page_permissions_page_check
  check (page in ('users', 'catalog', 'answer_bank', 'observability', 'coupons', 'chapter_notes'));

insert into public.admin_page_permissions (user_id, page)
select p.id, 'chapter_notes'
from public.profiles p
where p.role = 'admin'
on conflict (user_id, page) do nothing;
