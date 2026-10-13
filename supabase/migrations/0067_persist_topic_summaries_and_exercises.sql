-- Closes a reported gap: clicking a syllabus topic drops a summary bubble
-- (and whatever exercises get shown/generated under it) into the chat
-- timeline, but neither was ever persisted to chat_messages -- "an
-- accepted scope trim, not an oversight" per this table's own earlier
-- comments. Reported directly as a real problem: a page reload (or simply
-- coming back later) loses the whole practice session, and since the
-- orchestrator has no record of what it already generated once that
-- session is gone, regenerating via the same pattern pill has nothing to
-- avoid repeating.
--
-- topic_id: set only on a new 'topic_summary' role row (a topic bubble);
-- null on an ordinary 'user'/'assistant' row. FK to syllabus_topics so a
-- reload can recover the full chapter/topic/medium via a join instead of
-- duplicating that text here.
--
-- prefer_english: that bubble's own snapshot of the language toggle at
-- the moment its summary was generated (see chat-panel.tsx's TimelineEntry
-- comment on why this is a frozen per-bubble snapshot, not a live read) --
-- needed to re-render it identically after a reload.
--
-- exercises: the CURRENT combined exercise list TopicPractice is showing
-- under either a topic bubble (role='topic_summary') or an ordinary
-- assistant reply (role='assistant', matched to a topic) -- kept in sync
-- via PATCH /api/chat/[messageId]/exercises every time it changes (a
-- pattern-picker click, "More exercises", ...). Null until the first
-- exercise is shown. Stores full PracticeExerciseItem objects (id,
-- question, answer, type), not just question/answer text, so a restored
-- session's exercises stay individually gradeable.
alter table public.chat_messages
  add column topic_id uuid references public.syllabus_topics(id) on delete set null,
  add column prefer_english boolean not null default false,
  add column exercises jsonb;

alter table public.chat_messages drop constraint chat_messages_role_check;
alter table public.chat_messages add constraint chat_messages_role_check
  check (role = any (array['user'::text, 'assistant'::text, 'topic_summary'::text]));

comment on column public.chat_messages.topic_id is
  'Set only on a topic_summary row -- the syllabus topic this bubble is showing a summary/exercises for.';
comment on column public.chat_messages.exercises is
  'Full PracticeExerciseItem[] snapshot of whatever TopicPractice currently shows under this row (a topic_summary bubble or a matched-topic assistant reply) -- kept in sync via PATCH /api/chat/[messageId]/exercises.';
