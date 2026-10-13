-- Sibling of 0064_fix_shifted_curriculum_chapters.sql for West Bengal
-- Board Grade 10 Geography -- that migration deliberately left this
-- subject for later, since its real syllabus topic names are bilingual
-- ("বর্জ্য ব্যবস্থাপনা (Waste Management)") while the mined data has
-- Bengali-only/English-only variants that need NFC-normalized matching
-- to compare correctly (confirmed: a naive SQL lower(trim()) match found
-- 0 rows; Unicode NFC normalization was required, matching this
-- codebase's own curriculumReconciliation.ts normalize() convention).
--
-- Investigated with that normalization applied (see this session's own
-- analysis, not re-derivable from SQL alone): of 41 distinct mined
-- curriculum.topic values under the degenerate chapter.chapter =
-- "Bhugol O Poribesh" (this subject's book title, shared by all 17 real
-- chapters), only ONE -- "বর্জ্য ব্যবস্থাপনা" -- exactly matches a real
-- syllabus topic's Bengali half ("বর্জ্য ব্যবস্থাপনা (Waste
-- Management)"). Every other mined topic here is a genuinely finer or
-- differently-worded concept, not a whole-chapter-name duplicate the way
-- CBSE Physical Education's were -- so unlike that migration, this fix
-- only touches these 12 verified-exact rows; the rest of this subject's
-- "Bhugol O Poribesh" rows are left untouched (same graceful "no
-- sub-topic to show" degradation the app-level picker fix already gives
-- them, not a data error to force-correct on a guess).
with run_scope as (
  select distinct a.run_id
  from archetypes a
  where a.education_context->'curriculum_source'->>'name' = 'West Bengal Board'
    and a.education_context->>'subject_or_course' = 'Geography'
    and a.education_context->>'grade_or_year' = '10'
)
update archetype_question_signatures s
set signature = jsonb_set(
  jsonb_set(s.signature, '{curriculum,chapter}', '"বর্জ্য ব্যবস্থাপনা (Waste Management)"'::jsonb),
  '{curriculum,topic}', 'null'::jsonb
)
from run_scope rs
where s.run_id = rs.run_id
  and lower(trim(s.signature->'curriculum'->>'chapter')) = lower(trim('Bhugol O Poribesh'))
  and s.signature->'curriculum'->>'topic' = 'বর্জ্য ব্যবস্থাপনা';
