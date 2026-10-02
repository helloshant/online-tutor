-- Backs a new public "Business Enquiry" page (src/app/business/page.tsx) for
-- schools, coaching institutes, and other organisations that want to ask
-- about bulk/partnership plans -- distinct from callback_requests (an
-- individual student/parent asking for a support call back). Same
-- "write-only to the public, admin-only to read" shape as
-- callback_requests (0051_callback_requests.sql), for the same reason: an
-- enquiry is sales/support's own queue to work, not something the
-- submitter needs to look back up afterward.
create table public.business_enquiries (
  id uuid primary key default gen_random_uuid(),
  organization_name text not null,
  contact_name text not null,
  email text not null,
  phone text,
  -- Free text, not an integer -- real answers arrive as "around 300" or
  -- "40-50 per batch", not a single clean number, same leniency reasoning
  -- as callback_requests' own phone field.
  approx_students text,
  message text,
  status text not null default 'new' check (status in ('new', 'contacted')),
  created_at timestamptz not null default now(),
  contacted_at timestamptz,
  contacted_by uuid references auth.users (id) on delete set null
);

alter table public.business_enquiries enable row level security;

create policy "business_enquiries: anyone can insert"
  on public.business_enquiries for insert
  with check (true);

create policy "business_enquiries: admin can read"
  on public.business_enquiries for select
  using (public.is_admin());

create policy "business_enquiries: admin can update"
  on public.business_enquiries for update
  using (public.is_admin())
  with check (public.is_admin());

-- New admin page: "Business enquiries" -- same widen-constraint-then-grant
-- pattern as every prior admin page addition (e.g. 0051's own identical
-- comment).
alter table public.admin_page_permissions drop constraint admin_page_permissions_page_check;
alter table public.admin_page_permissions add constraint admin_page_permissions_page_check
  check (page in ('users', 'catalog', 'answer_bank', 'observability', 'coupons', 'chapter_notes', 'topic_summaries', 'broadcasts', 'feedback', 'archetype_miner', 'callback_requests', 'business_enquiries'));

insert into public.admin_page_permissions (user_id, page)
select p.id, 'business_enquiries'
from public.profiles p
where p.role = 'admin'
on conflict (user_id, page) do nothing;
