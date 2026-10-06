-- Replaces the flat ₹299/subject one-time-payment + monthly/trial token cap
-- with a prepaid token wallet: every student has a balance_tokens that
-- depletes by REAL LLM cost (see services/observability/src/server.ts),
-- gates every LLM call app-wide (see src/lib/walletBalance.ts), and an
-- llm_provider preference (gemini default, anthropic optional -- see
-- services/orchestrator/src/llm.ts). A wallet "token" is money-denominated
-- (₹500 = 200,000 tokens, see services/observability/src/walletPricing.ts),
-- so choosing Anthropic (pricier per real LLM token) burns the SAME wallet
-- faster rather than requiring a separate upgrade charge.
create table public.student_wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance_tokens bigint not null default 0,
  llm_provider text not null default 'gemini' check (llm_provider in ('gemini', 'anthropic')),
  updated_at timestamptz not null default now()
);

-- Backend-only writes (balance changes only ever happen via deduct_wallet/
-- credit_wallet below, never a direct client update) but the account page
-- needs to read a student's own balance/provider with the ordinary session
-- client -- same shape as student_usage_limits before it, just with a read
-- policy this table actually needs (that one never had a student-facing
-- read path at all).
alter table public.student_wallets enable row level security;
create policy "Students can view their own wallet"
  on public.student_wallets for select
  using (auth.uid() = user_id);

-- Every account always has a wallet row -- no null-handling needed anywhere
-- downstream. Starts at 0/gemini: no free trial grant, no special-casing
-- (confirmed explicitly -- a new signup must recharge before first use).
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
  insert into public.student_wallets (user_id) values (new.id);
  return new;
end;
$$;

-- Called by the observability service after every LLM call, once it has
-- computed the real USD cost for that call (see
-- services/observability/src/server.ts) -- deliberately allowed to go
-- negative: the call already happened and this is bookkeeping after the
-- fact, not a gate. The actual gate is the pre-call balance>0 check every
-- LLM-calling route performs (src/lib/walletBalance.ts) -- this function's
-- only job is to make the NEXT check see the real, current balance.
create function public.deduct_wallet(p_user_id uuid, p_tokens bigint)
returns bigint
language sql
security definer
set search_path = public
as $$
  update public.student_wallets
  set balance_tokens = balance_tokens - p_tokens, updated_at = now()
  where user_id = p_user_id
  returning balance_tokens;
$$;

-- Called by the payment service on a successful wallet recharge (see
-- services/payment/src/ccavenuePayment.ts), and by an admin's own "Grant
-- tokens" action (src/app/admin/users/[id]/page.tsx) -- same function,
-- same atomic add, regardless of who's crediting the wallet.
create function public.credit_wallet(p_user_id uuid, p_tokens bigint)
returns bigint
language sql
security definer
set search_path = public
as $$
  update public.student_wallets
  set balance_tokens = balance_tokens + p_tokens, updated_at = now()
  where user_id = p_user_id
  returning balance_tokens;
$$;

revoke all on function public.deduct_wallet(uuid, bigint) from public, anon, authenticated;
revoke all on function public.credit_wallet(uuid, bigint) from public, anon, authenticated;

comment on table public.student_wallets is
  'Prepaid LLM token wallet per student. balance_tokens is money-denominated (₹500 = 200,000 tokens) -- see services/observability/src/walletPricing.ts. Gates every LLM call; llm_provider picks gemini (default) or anthropic.';

-- Mirrors subscriptions' existing CCAvenue pattern (id as the CCAvenue
-- order_id, amount re-validated server-side, never trusted from the
-- client) -- see services/payment/src/ccavenuePayment.ts's new
-- initiateWalletTopup/handleCallback branch. A fixed top-up block only
-- (₹500 = 200,000 tokens, confirmed) -- amount_paise/tokens_credited are
-- still columns (not hardcoded in application code only) so a historical
-- top-up's real price stays recorded even if the block size ever changes.
create table public.wallet_topups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount_paise integer not null,
  tokens_credited bigint not null,
  status text not null default 'pending_payment' check (status in ('pending_payment', 'active')),
  ccavenue_tracking_id text,
  created_at timestamptz not null default now(),
  activated_at timestamptz
);

alter table public.wallet_topups enable row level security;
create policy "Students can view their own wallet top-ups"
  on public.wallet_topups for select
  using (auth.uid() = user_id);

comment on table public.wallet_topups is
  'CCAvenue-paid wallet recharges. Service-role write only (initiated by src/app/api/wallet/recharge/initiate, activated by the payment service''s callback handling); students can read their own recharge history.';
