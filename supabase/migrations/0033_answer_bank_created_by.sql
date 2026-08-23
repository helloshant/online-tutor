-- ---------------------------------------------------------------------------
-- Auditability for the shared answer bank: which user caused each row to
-- exist. Prompted directly by the questionRewrite.ts safeguard
-- (0031_answer_feedback.sql's follow-up discussion) -- once `question` is
-- deliberately a restated version rather than the student's raw wording,
-- there's no longer a copy of the original text to trace a problematic
-- entry back to its source with. created_by is the alternate trail: not
-- "what was typed," but "who typed it."
--
-- Populated by two different kinds of writer, both legitimate:
--   - services/orchestrator/src/answerBank.ts's recordAnswer -- the student
--     whose live chat question (or "Relevant Exercises" click) triggered
--     the LLM generation this entry banks.
--   - src/app/admin/answer-bank/actions.ts's bulkImportAnswers -- the admin
--     who authored/imported the entry directly.
-- Null for every row that predates this column, and for the rare write that
-- genuinely can't resolve one (there are none today, but nothing should
-- assume this is ever non-null).
-- ---------------------------------------------------------------------------
alter table public.answered_questions
  add column created_by uuid references auth.users (id) on delete set null;

create index answered_questions_created_by_idx on public.answered_questions (created_by);
