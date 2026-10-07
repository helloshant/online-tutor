-- Persists CCAvenue's actual decrypted callback whenever order_status
-- isn't "Success" -- previously both handleCallback (subscriptions) and
-- handleWalletTopupCallback (wallet top-ups) just mapped ANY non-Success
-- status to the same generic "payment_failed" redirect, with nothing
-- about WHY logged or stored anywhere -- confirmed live as the cause of
-- a report where a real CCAvenue transaction failed with no way to tell
-- whether it was a merchant-auth rejection, a declined card, an
-- abandoned 3D-secure step, or something else. Service-role only, same
-- posture as every other backend-only diagnostic table this session has
-- added (login_lockouts, exercise_generation_failures) -- this is a
-- debugging aid for staff, nothing a student ever reads or writes.
create table public.payment_callback_failures (
  id uuid primary key default gen_random_uuid(),
  order_id text not null,
  order_type text not null check (order_type in ('subscription', 'wallet_topup')),
  order_status text,
  failure_message text,
  raw_response text not null,
  created_at timestamptz not null default now()
);

alter table public.payment_callback_failures enable row level security;
