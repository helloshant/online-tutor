-- Per-admin grade scoping. Mirrors admin_page_permissions
-- (0008_admin_page_permissions.sql) but with the OPPOSITE default: a plain
-- admin with zero rows here is UNRESTRICTED (sees every grade), not locked
-- out. That's deliberate -- grade scoping is opt-in, narrowing an admin
-- down only once a superadmin explicitly assigns specific grades, so no
-- backfill insert is needed and no existing admin loses access just from
-- this migration landing. See getAllowedAdminGrades() in src/lib/auth.ts.
--
-- Superadmins are never gated by this table -- same "superadmin has
-- everything, plus more" hierarchy as admin_page_permissions.

create table public.admin_grade_permissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  grade_id uuid not null references public.grades (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, grade_id)
);

create index admin_grade_permissions_user_idx on public.admin_grade_permissions (user_id);

alter table public.admin_grade_permissions enable row level security;

create policy "admin_grade_permissions: user can read own" on public.admin_grade_permissions
  for select using (user_id = auth.uid());

create policy "admin_grade_permissions: superadmin can read all" on public.admin_grade_permissions
  for select using (public.is_superadmin());

create policy "admin_grade_permissions: superadmin can manage" on public.admin_grade_permissions
  for all using (public.is_superadmin()) with check (public.is_superadmin());
