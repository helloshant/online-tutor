-- ---------------------------------------------------------------------------
-- Tracks when each user's password was last set, so the app can enforce a
-- password-expiry policy for native (email/password) accounts. Google-only
-- accounts never have this set -- they have no password with this app to
-- expire, so the expiry check (isPasswordExpired() in src/lib/auth.ts)
-- treats null as "not applicable" rather than "never set, always expired".
-- ---------------------------------------------------------------------------
alter table public.profiles add column password_changed_at timestamptz;

-- Google sign-in doesn't populate raw_user_meta_data ->> 'full_name' the way
-- the app's own signup form does -- Supabase's Google provider uses 'name'.
-- Also stamp password_changed_at at creation time when the account was
-- created with a password (native signup or an admin-created account);
-- left null for an OAuth-only signup.
create or replace function public.handle_new_tutorops_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, password_changed_at)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    case when new.encrypted_password is not null and new.encrypted_password <> ''
      then now() else null end
  );
  return new;
end;
$$;

-- Keeps password_changed_at current for every later password change too
-- (password reset, the forced expiry flow, or an admin resetting someone's
-- password) -- not just the one set at signup.
create function public.handle_tutorops_password_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password then
    update public.profiles set password_changed_at = now() where id = new.id;
  end if;
  return new;
end;
$$;

create trigger on_tutorops_auth_user_password_change
  after update on auth.users
  for each row execute function public.handle_tutorops_password_change();
