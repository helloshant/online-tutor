-- Swaps the Razorpay-specific columns on subscriptions for CCAvenue's
-- equivalent, and adds a one-time-use coupon-code system for bypassing
-- payment entirely.
--
-- CCAvenue's redirect-based integration model means *we* choose the
-- order_id sent to them (unlike Razorpay, which mints its own order id
-- server-side and hands it back) -- this app just uses the subscription's
-- own id as the order_id, so there's no need for a separate
-- ccavenue_order_id column the way razorpay_order_id existed: the
-- callback route looks the subscription up by id directly. Only a
-- CCAvenue "tracking_id" (their own transaction reference, returned after
-- a successful payment) is worth keeping, for audit/support purposes --
-- same role razorpay_payment_id played.
alter table public.subscriptions drop column razorpay_order_id;
alter table public.subscriptions rename column razorpay_payment_id to ccavenue_tracking_id;

-- ---------------------------------------------------------------------------
-- Coupon codes: admin-generated, single-use overall (once redeemed by any
-- one student, the code is permanently spent -- not a per-student-once
-- code shared among many people). Redemption fully bypasses the payment
-- gateway and activates the subscription directly, the same end state as
-- the existing activateSubscriptionWithoutPayment admin action
-- (src/app/admin/actions.ts) -- a coupon is really just a self-service
-- version of that same escape hatch, gated by knowing a valid code instead
-- of admin access.
-- ---------------------------------------------------------------------------
create table public.coupon_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  created_by uuid not null references auth.users (id) on delete cascade,
  used_by uuid references auth.users (id) on delete set null,
  used_at timestamptz,
  subscription_id uuid references public.subscriptions (id) on delete set null,
  created_at timestamptz not null default now()
);

create index coupon_codes_code_idx on public.coupon_codes (code);

alter table public.coupon_codes enable row level security;

-- Admin panel (the new /admin/coupons page) reads/writes through the
-- ordinary session client, same pattern as subscriptions/catalog admin
-- actions -- gated by is_admin(), not a service-role-only table.
create policy "coupon_codes: admin can manage" on public.coupon_codes
  for all using (public.is_admin()) with check (public.is_admin());

-- No student-facing policy at all -- redemption (src/app/subscribe/actions.ts)
-- authenticates the caller in application code first, then does the actual
-- code lookup/claim and subscription activation through the service-role
-- client, the same "authenticate in app code, privileged write via
-- service-role" pattern every subscription-status change in this app
-- already follows (see /api/razorpay/verify's replacement in
-- src/app/api/ccavenue/callback/route.ts, and activateSubscriptionWithoutPayment).

-- ---------------------------------------------------------------------------
-- New admin page: "coupons". Same grandfathering approach 0008 used when it
-- was first introduced, so this doesn't silently lock out an admin who
-- could already reach every other page.
-- ---------------------------------------------------------------------------
alter table public.admin_page_permissions drop constraint admin_page_permissions_page_check;
alter table public.admin_page_permissions add constraint admin_page_permissions_page_check
  check (page in ('users', 'catalog', 'answer_bank', 'observability', 'coupons'));

insert into public.admin_page_permissions (user_id, page)
select p.id, 'coupons'
from public.profiles p
where p.role = 'admin'
on conflict (user_id, page) do nothing;
