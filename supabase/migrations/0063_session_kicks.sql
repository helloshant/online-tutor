-- Diagnostic log for the single-active-device mismatch kick in src/proxy.ts
-- (see 0050_single_device_session.sql). That check can only tell "this
-- browser's active_session_id cookie no longer matches
-- profiles.current_session_id" -- it can't tell whether that's because a
-- genuine OTHER sign-in overwrote the row, or because this same browser's
-- own cookie failed to persist/round-trip (confirmed possible with
-- compression/data-saver mobile browsers common among students, which
-- don't always forward cookies faithfully). Confirmed live as unexplained:
-- a student was force-logged-out repeatedly with no corresponding sign-in
-- from anywhere else in auth.audit_log_entries for their account -- with
-- nothing recorded at the moment of the kick itself, there was no way to
-- tell which of the two causes it actually was. Service-role only, same
-- posture as every other backend-only diagnostic table this session has
-- added (login_lockouts, exercise_generation_failures,
-- payment_callback_failures) -- a debugging aid for staff, nothing a
-- student ever reads or writes.
create table public.session_kicks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  path text not null,
  cookie_session_id uuid,
  db_session_id uuid not null,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table public.session_kicks enable row level security;
