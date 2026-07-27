-- ---------------------------------------------------------------------------
-- Per-topic practice exercises with worked solutions. Hand-curated by admins
-- (not LLM-generated) so they match the actual textbook, same rationale as
-- syllabus_topics itself. Scoped by FK to syllabus_topics rather than
-- duplicating board/grade/subject/medium/chapter/topic columns -- an
-- exercise only ever makes sense attached to one specific topic row, and
-- deleting that topic should take its exercises with it.
-- ---------------------------------------------------------------------------
create table public.topic_exercises (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references public.syllabus_topics (id) on delete cascade,
  question text not null,
  solution text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index topic_exercises_topic_idx on public.topic_exercises (topic_id, sort_order);

alter table public.topic_exercises enable row level security;

-- Same pattern as syllabus_topics: any signed-in user can read (students
-- need this to browse exercises for their subscribed subjects), only admins
-- can write.
create policy "topic_exercises: read for authenticated" on public.topic_exercises
  for select using (auth.role() = 'authenticated');
create policy "topic_exercises: admin write" on public.topic_exercises
  for all using (public.is_admin()) with check (public.is_admin());
