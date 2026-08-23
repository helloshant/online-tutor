-- ---------------------------------------------------------------------------
-- Per-answer 👍/👎 feedback, closing the loop the pipeline was missing:
-- topic_summaries/answered_questions already have an admin *review* gate
-- (validation_status) before a *generated* row gets reused across students,
-- but nothing lets a student flag a wrong answer they're looking at right
-- now, in any of the three places an LLM answer is shown (a live chat
-- reply, a topic summary, a generated exercise). Without this, a bad answer
-- just sits there -- worse for trust than the app having a visible bug,
-- since there's no way for anyone to notice.
--
-- Deliberately stores a content_snapshot rather than only a foreign key:
-- target_id means something different per `kind` (a chat_messages.id is a
-- stable, unique-per-reply row that always exists; a topic summary's
-- backing topic_summaries row may not exist at all yet when a student is
-- looking at one -- see the 'chapter_notes' source in
-- services/orchestrator/src/server.ts's /v1/topic-summary handler, which
-- serves straight from chapter_documents with no topic_summaries row
-- involved -- and a freshly generated exercise has no id returned to the
-- caller at all, see /v1/topic-exercises' `stored` array). Rather than
-- chase down a precise row reference for all three (impossible for two of
-- them without real plumbing, for no real benefit), target_id is a
-- best-effort pointer (a chat_messages.id, or a syllabus_topics.id for the
-- other two kinds -- what /admin/topic-summaries and /admin/answer-bank are
-- themselves keyed/filterable by) and content_snapshot is what actually
-- makes a row self-sufficient: exactly what the student saw when they
-- flagged it, readable by an admin even if the source content is since
-- edited, regenerated, or deleted entirely.
--
-- No unique constraint: a text column this size (a chat reply or topic
-- summary, potentially several KB) can't sit in a btree unique index (the
-- ~2.7KB single-row limit a default 8KB page allows), and "at most one open
-- vote per student per thing" is enforced in application code instead (see
-- src/app/api/feedback/route.ts's delete-then-insert), not worth a partial
-- index that would only ever cover one of the three kinds anyway.
create table public.answer_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('chat_message', 'topic_summary', 'exercise')),
  -- Best-effort, not a hard reference (no FK) -- see comment above for why
  -- this can't be a real foreign key across all three kinds uniformly.
  target_id uuid,
  subject_id uuid references public.subjects (id) on delete set null,
  -- Null for a chat_message (the question is the *previous* timeline
  -- entry, not part of this row) -- populated for topic_summary/exercise so
  -- an admin sees what was being asked about without a join.
  question text,
  content_snapshot text not null,
  rating text not null check (rating in ('up', 'down')),
  -- Optional free-text a student can add on a 👎 explaining what was wrong.
  note text,
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_by uuid references auth.users (id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index answer_feedback_status_idx on public.answer_feedback (status, created_at desc);
create index answer_feedback_kind_target_idx on public.answer_feedback (kind, target_id);
create index answer_feedback_subject_idx on public.answer_feedback (subject_id);

alter table public.answer_feedback enable row level security;
-- Same "backend-only table" posture as answered_questions/chapter_documents/
-- topic_summaries/broadcasts: RLS enabled, zero client-facing policies.
-- src/app/api/feedback/route.ts authenticates the student's session first,
-- then writes via createAdminClient(); /admin/feedback reads/resolves the
-- same way. No ordinary-session path to this table at all.

-- ---------------------------------------------------------------------------
-- Whether the /v1/chat reply this event records was grounded in chapter-
-- notes RAG (referenceChunks non-empty in buildTutorSystemPrompt) or was a
-- plain, ungrounded LLM generation -- lets an admin see, per subject, how
-- often students are getting the model's own general knowledge instead of
-- an answer actually tied to ingested chapter content, which is exactly
-- the signal for where to prioritize ingesting more chapter notes.
--
-- Only ever set for source='llm' chat events from /v1/chat itself --
-- topic-summary/topic-exercises generation never grounds on chapter_documents
-- (buildTopicSummaryPrompt/buildExerciseGenerationPrompt take no
-- referenceChunks param), so their 'llm'-source rows stay null here, same as
-- every non-'llm' source (cache/database/rejected/chapter_notes), where
-- "grounded" isn't a meaningful question in the first place -- same "null
-- means not applicable" convention the token/cost columns already use.
alter table public.chat_events add column grounded boolean;

-- ---------------------------------------------------------------------------
-- New admin page: "feedback". Same grandfathering approach every earlier
-- page addition (0008, 0019, 0024, 0026, 0028) used, so this doesn't
-- silently lock out an admin who could already reach every other page.
-- ---------------------------------------------------------------------------
alter table public.admin_page_permissions drop constraint admin_page_permissions_page_check;
alter table public.admin_page_permissions add constraint admin_page_permissions_page_check
  check (page in ('users', 'catalog', 'answer_bank', 'observability', 'coupons', 'chapter_notes', 'topic_summaries', 'broadcasts', 'feedback'));

insert into public.admin_page_permissions (user_id, page)
select p.id, 'feedback'
from public.profiles p
where p.role = 'admin'
on conflict (user_id, page) do nothing;
