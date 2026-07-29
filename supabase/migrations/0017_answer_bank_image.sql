-- Some banked questions (typically bulk-imported textbook exercises with a
-- diagram/figure) can't be fully captured as text alone -- this adds an
-- optional image attached to the entry. Stored in a public Supabase Storage
-- bucket rather than inline/base64 in the row: unlike chat's transient
-- per-message images (never persisted, see 0*_chat_events.sql-era image
-- work), a banked entry's image needs to persist and be served repeatedly to
-- every student who hits this question, not just shown once in a single
-- exchange.
alter table public.answered_questions
  add column image_url text;

-- Public bucket: an approved answer-bank image is served directly via public
-- URL to any student viewing this question, no per-request auth check
-- needed. Only the service-role admin client ever writes to it (see
-- src/app/admin/answer-bank/actions.ts's setImage/removeImage), so no
-- INSERT/UPDATE/DELETE policy is needed on storage.objects either --
-- service_role bypasses RLS entirely, and this bucket never receives
-- writes from any other role.
insert into storage.buckets (id, name, public)
values ('answer-bank-images', 'answer-bank-images', true)
on conflict (id) do nothing;
