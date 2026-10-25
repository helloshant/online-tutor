-- Adds the real CBSE Grade 10 board-exam section types the practice-paper
-- type-mix picker can now request (see practice-panel.tsx's own picker and
-- the orchestrator's practiceBlueprint.ts/PracticePaperQuestionType): 'sa'
-- (Short Answer, 3 marks -- distinct from the existing 'short_answer',
-- which the picker now relabels "VSA" at 2 marks), 'assertion_reasoning'
-- (1 mark, fixed 4-option format), and 'case_study' (a shared scenario
-- split into 3 independently-graded sub-parts worth 1+1+2 marks).
--
-- group_id/scenario are null for every ordinary question (including every
-- row that predates this migration). A Case Study scenario's 3 sub-part
-- rows share the same group_id and the same scenario text -- lets the
-- client group and render them as one card (scenario shown once, each
-- sub-part's own marks/grading feedback below) without a separate table:
-- each sub-part is still its own ordinary practice_paper_questions row
-- with its own answered_question_id/marks, so grading (which already
-- scores each question row independently) needs no changes at all.
alter table public.practice_paper_questions
  drop constraint practice_paper_questions_question_type_check,
  add constraint practice_paper_questions_question_type_check
    check (question_type in (
      'MCQ', 'short_answer', 'long_answer', 'numerical',
      'sa', 'assertion_reasoning', 'case_study'
    )),
  add column group_id uuid,
  add column scenario text;

comment on column public.practice_paper_questions.group_id is
  'Shared identifier for a Case Study scenario''s 3 sub-part rows -- null for every ordinary question.';
comment on column public.practice_paper_questions.scenario is
  'The shared scenario/passage text for a Case Study sub-part -- null for every ordinary question. Also baked into the start of each sub-part''s own answered_questions.question text, since grading looks up each question row''s expected answer independently with no shared context between rows.';
