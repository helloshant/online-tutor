-- Brute-force login protection: tracks failed password attempts per email
-- (not user_id -- pre-authentication we don't yet know if the account
-- exists) and imposes a short, time-limited lockout once a threshold is
-- hit. Time-limited rather than permanent specifically so an attacker can't
-- lock a real student out of their own account indefinitely just by
-- repeatedly submitting a wrong password.
create table public.login_lockouts (
  email text primary key,
  failed_attempts int not null default 0,
  first_failed_at timestamptz not null default now(),
  locked_until timestamptz
);

-- Backend-only table: service-role access alone, same posture as
-- answered_questions/chapter_document_chunks elsewhere in this schema. No
-- policies at all -- anon/authenticated can't read or write this even
-- indirectly.
alter table public.login_lockouts enable row level security;
revoke all on public.login_lockouts from anon, authenticated;

-- Atomically records one failed attempt and returns the resulting
-- locked_until (or null if still under threshold). Done as a single
-- upsert rather than read-then-write app-side logic so two concurrent
-- failed attempts for the same email can't both read a stale count and
-- undercount -- the ON CONFLICT DO UPDATE takes a row-level lock for the
-- duration of the statement.
--
-- Window and threshold are fixed here (not parameterized) since this is
-- the only caller: 5 failed attempts within a rolling 15-minute window
-- trigger a 15-minute lockout; a stale window (last failure >15 minutes
-- ago) resets the count instead of accumulating forever.
create function public.record_failed_login(p_email text)
returns timestamptz
language sql
security definer
set search_path = public
as $$
  insert into public.login_lockouts (email, failed_attempts, first_failed_at, locked_until)
  values (p_email, 1, now(), null)
  on conflict (email) do update set
    failed_attempts = case
      when login_lockouts.first_failed_at < now() - interval '15 minutes' then 1
      else login_lockouts.failed_attempts + 1
    end,
    first_failed_at = case
      when login_lockouts.first_failed_at < now() - interval '15 minutes' then now()
      else login_lockouts.first_failed_at
    end,
    locked_until = case
      when login_lockouts.first_failed_at < now() - interval '15 minutes' then null
      when login_lockouts.failed_attempts + 1 >= 5 then now() + interval '15 minutes'
      else login_lockouts.locked_until
    end
  returning locked_until;
$$;

revoke all on function public.record_failed_login(text) from public, anon, authenticated;

comment on table public.login_lockouts is
  'Failed login attempt tracking for brute-force protection. Service-role only.';
