-- Per-admin, per-page authorization. Until now every admin (role='admin')
-- had equal access to every page in /admin -- only role itself (via
-- is_admin()/is_superadmin()) gated anything. This adds a finer layer on
-- top: a superadmin can grant or revoke a specific admin's access to each
-- individual admin page, without touching their role.
--
-- Superadmins are never gated by this table -- their access is always full
-- and can't be restricted here (enforced in application code, see
-- requireAdminPage() in src/lib/auth.ts), consistent with the existing
-- "superadmin has everything admin has, plus more" hierarchy.

create table public.admin_page_permissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  page text not null check (page in ('users', 'catalog', 'answer_bank', 'observability')),
  created_at timestamptz not null default now(),
  unique (user_id, page)
);

create index admin_page_permissions_user_idx on public.admin_page_permissions (user_id);

alter table public.admin_page_permissions enable row level security;

-- A signed-in admin can read their own grants (needed to render their own
-- nav / decide what they can see). Only a superadmin can read everyone's,
-- or write at all.
create policy "admin_page_permissions: user can read own" on public.admin_page_permissions
  for select using (user_id = auth.uid());

create policy "admin_page_permissions: superadmin can read all" on public.admin_page_permissions
  for select using (public.is_superadmin());

create policy "admin_page_permissions: superadmin can manage" on public.admin_page_permissions
  for all using (public.is_superadmin()) with check (public.is_superadmin());

-- Grandfather in every existing admin with full access to every page that
-- exists today, so this migration doesn't silently lock anyone out of a
-- page they could already reach. New admins get the same default going
-- forward (see the setUserRole server action), and a superadmin can then
-- narrow it via /admin/authorization.
insert into public.admin_page_permissions (user_id, page)
select p.id, pages.page
from public.profiles p
cross join (values ('users'), ('catalog'), ('answer_bank'), ('observability')) as pages(page)
where p.role = 'admin'
on conflict (user_id, page) do nothing;
