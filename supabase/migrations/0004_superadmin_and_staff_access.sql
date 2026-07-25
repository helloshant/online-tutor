-- Adds a superadmin tier above admin, and lets staff (admin/superadmin) use
-- the tutor chat without ever subscribing or paying.
--
-- Role hierarchy: superadmin > admin > user.
--   - superadmin: everything admin has, PLUS the exclusive ability to grant
--     or revoke admin/superadmin on any account.
--   - admin: full catalog + user/subscription management (unchanged from
--     before), but can no longer change anyone's role -- including their
--     own -- to admin or superadmin. Role changes are enforced at the
--     database level (not just hidden in the UI), so this holds even if
--     called directly against the API.
--   - user: unchanged, must subscribe + pay to unlock subject Q&A.

-- ---------------------------------------------------------------------------
-- 1. Expand the role enum
-- ---------------------------------------------------------------------------
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('user', 'admin', 'superadmin'));

-- ---------------------------------------------------------------------------
-- 2. is_superadmin() + widen is_admin() to cover both staff tiers
-- ---------------------------------------------------------------------------
create function public.is_superadmin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'superadmin'
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'superadmin')
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Hard guard: only a superadmin may change anyone's role. This runs
-- regardless of which RLS policy let the UPDATE through, so it holds even
-- for a plain admin acting on their own account or another admin's.
-- ---------------------------------------------------------------------------
create function public.enforce_profile_role_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.role is distinct from old.role and not public.is_superadmin() then
    raise exception 'Only a superadmin can change a user''s role';
  end if;
  return new;
end;
$$;

create trigger profiles_role_change_guard
  before update on public.profiles
  for each row execute function public.enforce_profile_role_change();

-- ---------------------------------------------------------------------------
-- 4. Staff (admin/superadmin) chat needs no subscription: allow a null
-- subscription_id for their conversations, distinct from a paying student's
-- rows, which always carry one.
-- ---------------------------------------------------------------------------
alter table public.chat_messages alter column subscription_id drop not null;
