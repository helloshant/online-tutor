-- Row Level Security for the Online Tutor SaaS schema.
--
-- Server-side privileged operations (activating a subscription after a
-- verified Razorpay payment, calling the LLM and writing the assistant's
-- reply) are performed with the Supabase service-role key from trusted API
-- routes, which bypasses RLS entirely. Everything below governs what an
-- ordinary logged-in browser session (the anon/authenticated key) may do
-- directly.

create function public.is_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

create policy "profiles: user can read own row"
  on public.profiles for select
  using (id = auth.uid());

create policy "profiles: admin can read all rows"
  on public.profiles for select
  using (public.is_admin());

create policy "profiles: user can update own row"
  on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid() and role = 'user');

create policy "profiles: admin can update all rows"
  on public.profiles for update
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Catalog tables: readable by any signed-in user (needed for onboarding and
-- to let the client render subject lists), writable only by admins.
-- ---------------------------------------------------------------------------
alter table public.boards enable row level security;
alter table public.grades enable row level security;
alter table public.subjects enable row level security;
alter table public.board_grade_subjects enable row level security;
alter table public.syllabus_topics enable row level security;

create policy "boards: read for authenticated" on public.boards
  for select using (auth.role() = 'authenticated');
create policy "boards: admin write" on public.boards
  for all using (public.is_admin()) with check (public.is_admin());

create policy "grades: read for authenticated" on public.grades
  for select using (auth.role() = 'authenticated');
create policy "grades: admin write" on public.grades
  for all using (public.is_admin()) with check (public.is_admin());

create policy "subjects: read for authenticated" on public.subjects
  for select using (auth.role() = 'authenticated');
create policy "subjects: admin write" on public.subjects
  for all using (public.is_admin()) with check (public.is_admin());

create policy "board_grade_subjects: read for authenticated" on public.board_grade_subjects
  for select using (auth.role() = 'authenticated');
create policy "board_grade_subjects: admin write" on public.board_grade_subjects
  for all using (public.is_admin()) with check (public.is_admin());

create policy "syllabus_topics: read for authenticated" on public.syllabus_topics
  for select using (auth.role() = 'authenticated');
create policy "syllabus_topics: admin write" on public.syllabus_topics
  for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- subscriptions
-- Users may read/create their own subscriptions (a new one starts life as
-- 'pending_payment'). Only the server (service-role key, after verifying the
-- Razorpay payment signature) or an admin may transition status/payment
-- fields, so there is no user-facing update policy.
-- ---------------------------------------------------------------------------
alter table public.subscriptions enable row level security;

create policy "subscriptions: user can read own" on public.subscriptions
  for select using (user_id = auth.uid());

create policy "subscriptions: admin can read all" on public.subscriptions
  for select using (public.is_admin());

create policy "subscriptions: user can create own pending subscription"
  on public.subscriptions for insert
  with check (user_id = auth.uid() and status = 'pending_payment');

create policy "subscriptions: admin can update any" on public.subscriptions
  for update using (public.is_admin());

-- ---------------------------------------------------------------------------
-- subscription_subjects
-- ---------------------------------------------------------------------------
alter table public.subscription_subjects enable row level security;

create policy "subscription_subjects: user can read own" on public.subscription_subjects
  for select using (
    exists (
      select 1 from public.subscriptions s
      where s.id = subscription_subjects.subscription_id
        and s.user_id = auth.uid()
    )
  );

create policy "subscription_subjects: admin can read all" on public.subscription_subjects
  for select using (public.is_admin());

create policy "subscription_subjects: user can attach to own pending subscription"
  on public.subscription_subjects for insert
  with check (
    exists (
      select 1 from public.subscriptions s
      where s.id = subscription_subjects.subscription_id
        and s.user_id = auth.uid()
        and s.status = 'pending_payment'
    )
  );

create policy "subscription_subjects: user can remove from own pending subscription"
  on public.subscription_subjects for delete
  using (
    exists (
      select 1 from public.subscriptions s
      where s.id = subscription_subjects.subscription_id
        and s.user_id = auth.uid()
        and s.status = 'pending_payment'
    )
  );

create policy "subscription_subjects: admin can manage all" on public.subscription_subjects
  for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- chat_messages
-- Writes only ever happen server-side (the /api/chat route, using the
-- service-role key, after it has independently verified the caller's
-- session, subscription ownership, active status, and subject access). This
-- keeps a user from ever writing a fake 'assistant' message or bypassing the
-- syllabus/subject scoping by hitting the table directly.
-- ---------------------------------------------------------------------------
alter table public.chat_messages enable row level security;

create policy "chat_messages: user can read own" on public.chat_messages
  for select using (user_id = auth.uid());

create policy "chat_messages: admin can read all" on public.chat_messages
  for select using (public.is_admin());
