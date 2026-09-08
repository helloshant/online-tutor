-- New Stage 1 review-queue source: a question whose actual content
-- doesn't belong to its declared education_context.subject_or_course or
-- grade_or_year at all (a different subject's content bundled into the
-- same paper, or genuinely a different grade's own syllabus) -- see
-- services/archetype-miner/src/types.ts's own OFF_SCOPE_CONTENT_FLAG
-- comment for what this catches and why it exists. Confirmed live in
-- production: exactly this slipped through undetected and reached a
-- real, student-facing archetype (a "Biology" archetype whose only
-- supporting question was an English poem's own MCQ). Distinct from
-- stage1_low_confidence -- that's "the model isn't sure which chapter,"
-- this is "the model is confident this doesn't belong to this
-- subject/grade at all," a materially more urgent review reason.
alter table public.archetype_review_queue drop constraint archetype_review_queue_source_check;
alter table public.archetype_review_queue add constraint archetype_review_queue_source_check
  check (source in ('stage1_low_confidence', 'stage1_off_scope_content', 'stage2_ambiguous_cluster', 'stage3_review_flag'));
