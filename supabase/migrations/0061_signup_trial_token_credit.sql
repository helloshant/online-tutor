-- New signups get a small free-trial credit instead of starting at zero
-- -- reverses 0055_student_wallets.sql's own explicit "no free trial
-- grant, confirmed explicitly" decision, after the business decided a
-- brand-new student should be able to try the tutor before their first
-- recharge. 10,000 tokens (~₹25 at the standard ₹500/200,000-token
-- rate, see services/observability/src/walletPricing.ts) -- a short real
-- test, not a meaningful free tier. Existing students are untouched:
-- this only changes what a FRESH signup's wallet row is inserted with.
-- student_wallets.balance_tokens' own column default stays 0 for any
-- other insert path (e.g. a future backfill), so this credit only ever
-- applies through this one trigger, at account creation.
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
  insert into public.student_wallets (user_id, balance_tokens) values (new.id, 10000);
  return new;
end;
$$;
