-- Onboarding (src/app/onboarding/actions.ts's confirmSelection) was
-- simplified to always write status: 'active' directly -- board/grade/
-- subject selection is free and instant now, no more payment-gated
-- pending_payment step. This table's own RLS was never updated to match:
-- the INSERT policy still required status = 'pending_payment', so EVERY
-- brand-new student's first subscription insert was silently rejected by
-- RLS -- confirmed live ("Could not save your selection. Please try
-- again.", reported for a student with literally zero subscriptions
-- rows, i.e. this was their very first attempt).
--
-- Separately, there was no UPDATE policy letting a student touch their
-- own row at all (only "subscriptions: admin can update any" existed) --
-- confirmSelection's own update-in-place branch (an existing student
-- changing board/grade/medium/subjects) was being silently swallowed by
-- RLS too, worse than the insert case since that call's result is never
-- checked, so it would have looked like it succeeded.
drop policy "subscriptions: user can create own pending subscription" on public.subscriptions;

create policy "subscriptions: user can create own active subscription"
  on public.subscriptions
  for insert
  with check (user_id = auth.uid() and status = 'active');

create policy "subscriptions: user can update own"
  on public.subscriptions
  for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and status = 'active');
