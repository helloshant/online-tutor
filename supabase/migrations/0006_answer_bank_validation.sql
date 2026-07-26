-- Adds a validation layer to the answer bank so it can be trusted to serve
-- other students without a human looking at every single row, while still
-- giving admins a way to catch and demote bad entries.
--
-- Two complementary validation mechanisms, matching how orchestrator writes
-- land here (see services/orchestrator/src/answerValidation.ts):
--   - Implicit (automatic, at write time): cheap heuristics on the LLM's
--     own reply -- length, hedging language, whether it reads like a
--     question asked back rather than an answer -- decide whether an
--     answer is confident enough to auto-approve (servable immediately) or
--     merely worth keeping for a human to confirm (pending_review, not yet
--     servable). Answers that fail outright are never inserted at all.
--   - Explicit (an admin/superadmin, after the fact, via /admin/answer-bank):
--     promote a pending_review row to admin_approved, or demote any row
--     (including an auto_approved one that turned out wrong) to rejected.
--
-- search_answer_bank only ever returns auto_approved/admin_approved rows --
-- pending_review and rejected rows are never served to a student.

alter table public.answered_questions
  add column validation_status text not null default 'auto_approved'
    check (validation_status in ('auto_approved', 'pending_review', 'admin_approved', 'rejected'));

create index answered_questions_validation_idx
  on public.answered_questions (validation_status);

create or replace function public.search_answer_bank(
  p_board_id uuid,
  p_grade_id uuid,
  p_subject_id uuid,
  p_medium text,
  p_query text,
  p_min_rank real default 0.1
)
returns table (id uuid, answer text, rank real)
language sql
stable
security definer set search_path = public
as $$
  select id, answer, rank
  from (
    select id, answer, ts_rank(question_tsv, websearch_to_tsquery('simple', p_query)) as rank
    from public.answered_questions
    where board_id = p_board_id
      and grade_id = p_grade_id
      and subject_id = p_subject_id
      and medium = p_medium
      and validation_status in ('auto_approved', 'admin_approved')
      and question_tsv @@ websearch_to_tsquery('simple', p_query)
  ) ranked
  where rank >= p_min_rank
  order by rank desc
  limit 1;
$$;

-- Give admins/superadmins a review queue through the ordinary browser
-- session, same pattern as the syllabus catalog tables (RLS + is_admin()),
-- rather than routing this through the orchestrator's service-role RPCs.
-- Still no insert policy: rows only ever originate from the orchestrator
-- (service-role key, which bypasses RLS), never directly from a client.
create policy "answered_questions: admin can read all" on public.answered_questions
  for select using (public.is_admin());

create policy "answered_questions: admin can update" on public.answered_questions
  for update using (public.is_admin()) with check (public.is_admin());

create policy "answered_questions: admin can delete" on public.answered_questions
  for delete using (public.is_admin());
