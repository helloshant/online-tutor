-- Usage-based pricing enforcement: students are asked how the tutor is
-- priced expecting an actual cap tied to real usage, not just an admin
-- dashboard (see /admin/observability, built earlier) that reports cost
-- after the fact with nothing gating it. This adds the missing half: a
-- per-student monthly token allowance that /api/chat actually enforces
-- before spending anything on an LLM call, on top of the cost data
-- chat_events (0007_chat_events.sql) already records for every request.
--
-- Deliberately its OWN table, not a column on profiles: profiles already
-- has a self-service "user can update own row" policy (0002_rls_policies.sql)
-- that only pins `role`, so a plain column here would let a student raise
-- their own quota with a direct PostgREST PATCH against their own
-- profiles row, using nothing more than their own logged-in session --
-- silently defeating the entire point of a billing cap. This table has no
-- self-write policy at all: a student can read their own row (for a future
-- usage-display UI, not built yet) but never write it.
create table public.student_usage_limits (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- No row for a user == the platform default limit applies (see
  -- DEFAULT_MONTHLY_TOKEN_LIMIT in src/app/api/chat/route.ts). A row IS
  -- the admin's explicit override once one exists:
  --   0   -- explicitly unlimited (a real cap of literally zero tokens is
  --         never a sensible plan, so 0 is repurposed as the "no limit"
  --         sentinel instead of adding a second boolean column for it)
  --   N>0 -- this student's own cap, replacing the platform default
  monthly_token_limit integer not null check (monthly_token_limit >= 0),
  updated_at timestamptz not null default now()
);

alter table public.student_usage_limits enable row level security;

create policy "student_usage_limits: user can read own row"
  on public.student_usage_limits for select
  using (user_id = auth.uid());

create policy "student_usage_limits: admin can read all rows"
  on public.student_usage_limits for select
  using (public.is_admin());

create policy "student_usage_limits: admin can write"
  on public.student_usage_limits for all
  using (public.is_admin())
  with check (public.is_admin());

-- Sums a specific student's LLM-sourced token usage since a given
-- timestamp -- /api/chat calls this (service-role) with the start of the
-- current calendar month, before spending anything on a new LLM call, to
-- decide whether they're still under their allowance. A real Postgres
-- aggregate rather than pulling every chat_events row into the request and
-- summing in JS: this runs on every single chat message (unlike
-- /admin/observability's own JS-side aggregation, a rarely-loaded report
-- page where that tradeoff is fine -- see that page's own comment), so it
-- needs to stay a single fast indexed query
-- (chat_events_user_created_idx already covers user_id, created_at) rather
-- than one that grows linearly with how much a heavy user has already
-- asked this month.
--
-- security definer + a service_role-only grant: this is NOT exposed to an
-- ordinary session, only to /api/chat's trusted server-side service-role
-- client, which supplies p_user_id from the authenticated request's own
-- user, never from client input -- letting any authenticated caller pass
-- an arbitrary p_user_id here would leak another student's usage.
create or replace function public.monthly_llm_tokens_for_user(p_user_id uuid, p_since timestamptz)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(total_tokens), 0)::bigint
  from public.chat_events
  where user_id = p_user_id
    and source = 'llm'
    and created_at >= p_since;
$$;

-- "revoke all ... from public" alone is NOT sufficient here: Supabase's
-- public schema has ALTER DEFAULT PRIVILEGES configured to auto-grant
-- EXECUTE on every newly created function EXPLICITLY to anon and
-- authenticated (not via the PUBLIC pseudo-role), so revoking from PUBLIC
-- alone leaves those two untouched -- confirmed directly against this
-- exact function via information_schema.role_routine_grants before this
-- line was added. Both revokes below are required, not redundant.
revoke all on function public.monthly_llm_tokens_for_user(uuid, timestamptz) from public;
revoke execute on function public.monthly_llm_tokens_for_user(uuid, timestamptz) from authenticated;
revoke execute on function public.monthly_llm_tokens_for_user(uuid, timestamptz) from anon;
grant execute on function public.monthly_llm_tokens_for_user(uuid, timestamptz) to service_role;
