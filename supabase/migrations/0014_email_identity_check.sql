-- admin.auth.admin.listUsers() (used by /admin's bulk user list) does not
-- reliably populate each returned user's `identities` array the way
-- admin.auth.admin.getUserById() does -- checking `u.identities?.some(...)`
-- against the bulk-list response silently evaluates to false for every
-- row, regardless of what's actually in auth.identities. This RPC queries
-- the real table directly for a batch of user ids, so both /admin and
-- /admin/users/[id] can check "does this account actually have a password"
-- reliably instead of trusting whatever listUsers()/getUserById() happen to
-- populate.
create function public.get_users_with_email_identity(p_user_ids uuid[])
returns table (user_id uuid, has_email_identity boolean)
language sql
stable
security definer set search_path = public
as $$
  select u.id, exists (
    select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email'
  )
  from auth.users u
  where u.id = any(p_user_ids);
$$;

revoke execute on function public.get_users_with_email_identity(uuid[]) from public;
grant execute on function public.get_users_with_email_identity(uuid[]) to service_role;
