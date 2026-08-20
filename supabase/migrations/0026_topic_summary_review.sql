-- ---------------------------------------------------------------------------
-- Adds an admin-review gate to topic_summaries, matching the review gate
-- answered_questions already has (0006_answer_bank_validation.sql): an
-- LLM-generated topic summary now lands as 'pending_review', not something
-- other students are served, until an admin explicitly confirms it via a
-- new /admin/topic-summaries page. See services/orchestrator/src/server.ts's
-- rewritten /v1/topic-summary handler for the read-side lookup order this
-- backs (RAG chapter notes -> Redis cache -> approved database row -> LLM).
--
-- Unlike answered_questions, there's no auto-approve heuristic here: every
-- LLM-generated summary always starts 'pending_review' -- a single summary
-- per topic (topic_summaries.topic_id is unique) is reused by every student
-- who opens that topic, so it's worth a human's confirmation every time,
-- not just when the LLM's own output looks shaky the way a one-off chat
-- answer does.
-- ---------------------------------------------------------------------------

alter table public.topic_summaries
  -- Existing rows predate this review gate and were already being served
  -- to students without incident -- default them to 'approved' rather than
  -- retroactively hiding already-live content behind a queue no admin has
  -- seen yet. Only summaries generated *after* this migration start at
  -- 'pending_review' (set explicitly by the orchestrator's write path, not
  -- by this column's default).
  add column validation_status text not null default 'approved'
    check (validation_status in ('pending_review', 'approved', 'rejected')),
  -- Tracks the most recent (re)generation, distinct from created_at (the
  -- row's original insert) -- a rejected summary gets regenerated in place
  -- (upsert on topic_id) rather than as a new row, so this is what "most
  -- recently generated, awaiting review" sorting in the admin queue uses.
  add column updated_at timestamptz not null default now();

create index topic_summaries_validation_idx on public.topic_summaries (validation_status);

-- Same "admin panel reads/writes through the ordinary session, RLS +
-- is_admin()" pattern as answered_questions (0006) -- topic_summaries
-- previously had RLS enabled with zero policies at all (see 0013's own
-- comment: "no admin-review UI for these"), since nothing outside the
-- orchestrator's service-role connection ever needed to touch it before now.
create policy "topic_summaries: admin can read all" on public.topic_summaries
  for select using (public.is_admin());

create policy "topic_summaries: admin can update" on public.topic_summaries
  for update using (public.is_admin()) with check (public.is_admin());

create policy "topic_summaries: admin can delete" on public.topic_summaries
  for delete using (public.is_admin());

-- ---------------------------------------------------------------------------
-- New chat_events source: a topic-summary answered straight from
-- admin-authored chapter notes (chapter_documents), the same RAG store
-- 0024_chapter_documents_rag.sql built for chat grounding, now checked
-- first for topic summaries too since it's curated content an admin
-- already vouches for -- no review gate needed, unlike the LLM path.
-- ---------------------------------------------------------------------------

alter table public.chat_events drop constraint chat_events_source_check;
alter table public.chat_events add constraint chat_events_source_check
  check (source in ('cache', 'database', 'llm', 'rejected', 'chapter_notes'));

-- ---------------------------------------------------------------------------
-- New admin page: "topic_summaries". Same grandfathering approach every
-- earlier page addition (0008, 0019, 0024) used, so this doesn't silently
-- lock out an admin who could already reach every other page.
-- ---------------------------------------------------------------------------

alter table public.admin_page_permissions drop constraint admin_page_permissions_page_check;
alter table public.admin_page_permissions add constraint admin_page_permissions_page_check
  check (page in ('users', 'catalog', 'answer_bank', 'observability', 'coupons', 'chapter_notes', 'topic_summaries'));

insert into public.admin_page_permissions (user_id, page)
select p.id, 'topic_summaries'
from public.profiles p
where p.role = 'admin'
on conflict (user_id, page) do nothing;
