-- Attribution for where a signup came from -- captured client-side as a
-- first-touch cookie in src/proxy.ts (?utm_source=/?ref=, ?utm_campaign=)
-- and threaded through at account-creation time so promotion channels can
-- actually be measured instead of guessed at.
alter table public.profiles
  add column signup_source text,
  add column signup_campaign text;

-- Native (email/password) signup passes signup_source/signup_campaign
-- through supabase.auth.signUp()'s options.data (see
-- src/app/signup/actions.ts), so they land in raw_user_meta_data the same
-- way full_name already does. Google OAuth has no equivalent hook -- that
-- path instead patches the profile row after the fact in
-- src/app/auth/callback/route.ts.
create or replace function public.handle_new_tutorops_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, password_changed_at, signup_source, signup_campaign)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    case when new.encrypted_password is not null and new.encrypted_password <> ''
      then now() else null end,
    new.raw_user_meta_data ->> 'signup_source',
    new.raw_user_meta_data ->> 'signup_campaign'
  );
  return new;
end;
$$;
