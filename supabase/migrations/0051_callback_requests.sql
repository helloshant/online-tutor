-- Backs the new public Contact page's "Request Callback" form
-- (src/app/contact/page.tsx) -- a visitor leaves their name and phone
-- number, unauthenticated (this is reached before signup, same posture as
-- the signup form itself), and support calls them back. No client-facing
-- read policy: only staff need to see these, the same "write-only to the
-- public, admin-only to read" shape student_usage_limits already
-- established for a different reason (see 0037's own comment) -- here
-- it's simply that a callback request is support's own queue to work,
-- not something the submitter needs to look back up afterward.
create table public.callback_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  message text,
  -- 'new' until an admin marks it handled -- mirrors answer_feedback's own
  -- open/resolved shape (0031_answer_feedback.sql), just named for what a
  -- callback request's own lifecycle actually is.
  status text not null default 'new' check (status in ('new', 'contacted')),
  created_at timestamptz not null default now(),
  contacted_at timestamptz,
  contacted_by uuid references auth.users (id) on delete set null
);

alter table public.callback_requests enable row level security;

-- Anyone -- including an anonymous visitor who hasn't signed up yet -- can
-- submit a request. No select/update/delete grant here: a submitter can
-- never read back their own (or anyone else's) request once sent.
create policy "callback_requests: anyone can insert"
  on public.callback_requests for insert
  with check (true);

create policy "callback_requests: admin can read"
  on public.callback_requests for select
  using (public.is_admin());

create policy "callback_requests: admin can update"
  on public.callback_requests for update
  using (public.is_admin())
  with check (public.is_admin());

-- New admin page: "Callback requests" -- same two-step pattern every prior
-- admin page addition used (e.g. 0031_answer_feedback.sql's own identical
-- comment): widen the check constraint, then grant it to every existing
-- plain admin by default so this doesn't silently lock an admin out of a
-- page they could already reach everything else on.
alter table public.admin_page_permissions drop constraint admin_page_permissions_page_check;
alter table public.admin_page_permissions add constraint admin_page_permissions_page_check
  check (page in ('users', 'catalog', 'answer_bank', 'observability', 'coupons', 'chapter_notes', 'topic_summaries', 'broadcasts', 'feedback', 'archetype_miner', 'callback_requests'));

insert into public.admin_page_permissions (user_id, page)
select p.id, 'callback_requests'
from public.profiles p
where p.role = 'admin'
on conflict (user_id, page) do nothing;
