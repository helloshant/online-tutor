-- Sibling of 0058_subscriptions_rls_active_status.sql's own fix, found
-- the same way: a student (board/grade/subscription saved fine after
-- that fix) landed on /dashboard with "No subjects subscribed." despite
-- choosing 5 subjects during onboarding -- confirmed live, their
-- subscriptions row exists with status='active' but subscription_subjects
-- has zero rows for it.
--
-- confirmSelection (src/app/onboarding/actions.ts) always writes
-- status: 'active' to subscriptions now -- board/grade/subject selection
-- is free and instant, no more payment-gated pending_payment step. This
-- table's own INSERT and DELETE policies were never updated to match:
-- both still required the subscription to be status = 'pending_payment',
-- so attaching ANY subject to a (now always 'active') subscription was
-- silently rejected by RLS, and so was the update-in-place branch's own
-- "clear subjects before re-inserting" delete.
drop policy "subscription_subjects: user can attach to own pending subscription" on public.subscription_subjects;
drop policy "subscription_subjects: user can remove from own pending subscription" on public.subscription_subjects;

create policy "subscription_subjects: user can attach to own active subscription"
  on public.subscription_subjects for insert
  with check (
    exists (
      select 1 from public.subscriptions s
      where s.id = subscription_subjects.subscription_id
        and s.user_id = auth.uid()
        and s.status = 'active'
    )
  );

create policy "subscription_subjects: user can remove from own active subscription"
  on public.subscription_subjects for delete
  using (
    exists (
      select 1 from public.subscriptions s
      where s.id = subscription_subjects.subscription_id
        and s.user_id = auth.uid()
        and s.status = 'active'
    )
  );
