-- Revisits the two shared-chapter groups 0066 explicitly left untouched --
-- WB Bengali "Sahitya Sanchayan" and WB Mathematics "Ganit Prakash" --
-- using the real sample question text the new "Unmatched topics" admin
-- tool (services/archetype-miner/src/topicReconciliation.ts) surfaces for
-- exactly this purpose. 0066's own comment said every mined topic value
-- in both groups was an unplaceable question-type description; reading
-- the actual question text (not just the topic label) turned up two
-- that ARE confidently placeable after all -- the other three remain
-- genuinely ambiguous and are left alone, same discipline 0066 itself
-- used, for a human to judge from the admin page later.
--
-- Same attachTopicMapping semantics as the admin tool itself: writes the
-- real topic onto curriculum.chapter; curriculum.topic is left exactly as
-- mined (it's a legitimate within-topic concept now, not an ambiguous
-- label -- unlike 0066's own mapping table, there's no "keep_topic: false"
-- case here).
--
-- সিন্ধুতীরে (Sindhutire): the mined topic "পঙক্তি বিশ্লেষণ" (line
-- analysis) sits on question text that literally quotes the chapter's own
-- title -- "সিন্ধুতীরে দেখি দিব্যস্থান।" ("By the sea's shore I saw a
-- divine place") -- about as direct a confirmation as sample text can give
-- without the full poem in front of you.
--
-- দ্বিঘাত করণী (Quadratic Surds): the mined topic "সংখ্যার ধরণ" (number
-- type), concept "Irrational Numbers", on a fill-in-the-blank asking what
-- type of number 7√11 is -- a textbook quadratic-surd classification
-- question.
with mapping(subject, shared_chapter, mined_topic, real_topic) as (
  values
    ('Bengali', 'Sahitya Sanchayan', 'পঙক্তি বিশ্লেষণ', 'সিন্ধুতীরে'),
    ('Mathematics', 'Ganit Prakash', 'সংখ্যার ধরণ', 'দ্বিঘাত করণী (Quadratic Surds)')
),
run_scope as (
  select distinct a.run_id,
    a.education_context->>'subject_or_course' as subject
  from archetypes a
  where a.education_context->'curriculum_source'->>'name' = 'West Bengal Board'
    and a.education_context->>'grade_or_year' = '10'
    and a.education_context->>'subject_or_course' in ('Bengali', 'Mathematics')
),
target_rows as (
  select s.run_id, s.question_id, m.real_topic
  from archetype_question_signatures s
  join run_scope rs on rs.run_id = s.run_id
  join mapping m on m.subject = rs.subject
    and lower(trim(s.signature->'curriculum'->>'chapter')) = lower(trim(m.shared_chapter))
    and s.signature->'curriculum'->>'topic' = m.mined_topic
)
update archetype_question_signatures s
set signature = jsonb_set(s.signature, '{curriculum,chapter}', to_jsonb(tr.real_topic))
from target_rows tr
where s.run_id = tr.run_id and s.question_id = tr.question_id;
