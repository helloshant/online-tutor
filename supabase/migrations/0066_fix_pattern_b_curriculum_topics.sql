-- Remediates the "Pattern B" groups flagged alongside the Physical
-- Education/Geography fixes (0064, 0065): unlike those, here
-- curriculum.chapter is already CORRECT -- a real, legitimate book-section
-- grouping (e.g. WB Bengali "ব্যাকরণ"/Grammar, WB English "Writing") that
-- genuinely spans multiple real syllabus topics. The problem is
-- curriculum.topic: a mix of values that are themselves exact real
-- syllabus topic names (should have BEEN the chapter, one level too
-- coarse to stay in topic) and values that are genuinely finer
-- sub-concepts of one specific real topic (correctly fine-grained, just
-- never reclassified down to sit under that topic's own name).
--
-- No LLM available in this environment to run this through this app's
-- own curriculumReconciliation.ts-style pipeline (that tool wouldn't have
-- helped here anyway -- it only reconciles curriculum.chapter, and these
-- chapters already match real syllabus values trivially, same reasoning
-- 0065's own comment gives for why that tool skips "Bhugol O Poribesh").
-- Mapped by hand instead, against each group's own real within-chapter
-- topic list, using the exact same conservative discipline
-- curriculumReconciliation.ts's prompt enforces: map only when a mined
-- topic is confidently the SAME concept (paraphrase/translation -- "exact"
-- rows below, topic cleared to null, no residual finer concept to keep)
-- or a genuine SPECIFIC SUB-CONCEPT of one real topic ("finer" rows,
-- topic kept as-is -- it's now legitimate, useful sub-topic picker data,
-- e.g. "তৎপুরুষ সমাস" under the real topic "সমাস"). Spot-verified against
-- this same row's own curriculum.concept field independently agreeing
-- (e.g. "তৎপুরুষ সমাস" row's concept: "Classification of Tatpurusha
-- Compounds"). Anything too ambiguous or off-taxonomy to confidently
-- place (dual-target labels, essay PROMPT topics rather than writing-type
-- categories, analytical-task descriptions with no story title attached)
-- is left untouched, same as a genuinely unmatched value in that tool.
--
-- WB Bengali "Sahitya Sanchayan" and WB Mathematics "Ganit Prakash" are
-- NOT touched by this migration at all -- every one of their own mined
-- topic values turned out to be a question-type description (e.g. "line
-- analysis") or a non-taxonomy label with no confident real-topic home,
-- not a case 1/2 mapping this process can make safely.
with mapping(subject, shared_chapter, mined_topic, real_topic, keep_topic) as (
  values
    -- WB English Grammar
    ('English', 'Grammar', 'Direct and Indirect Speech', 'Narration (Direct-Indirect Speech)', false),
    ('English', 'Grammar', 'Voice', 'Voice Change (Active-Passive)', false),
    ('English', 'Grammar', 'Verb Forms', 'Tense', true),
    ('English', 'Grammar', 'Word Formation', 'Word Formation', false),
    ('English', 'Grammar', 'Sentence Transformation', 'Transformation of Sentences', false),
    ('English', 'Grammar', 'Tenses', 'Tense', false),
    ('English', 'Grammar', 'Voice Transformation', 'Voice Change (Active-Passive)', false),
    ('English', 'Grammar', 'Compound to Simple Sentence', 'Transformation of Sentences', true),
    ('English', 'Grammar', 'Reported Speech', 'Narration (Direct-Indirect Speech)', false),
    ('English', 'Grammar', 'Tenses and Verb Forms', 'Tense', false),
    ('English', 'Grammar', 'Verb Tense and Usage', 'Tense', false),
    ('English', 'Grammar', 'Voice Change', 'Voice Change (Active-Passive)', false),
    -- WB English Writing
    ('English', 'Writing', 'Notice Writing', 'Notice Writing', false),
    ('English', 'Writing', 'Paragraph Writing', 'Paragraph or Essay Writing', false),
    ('English', 'Writing', 'Descriptive Paragraph', 'Paragraph or Essay Writing', true),
    ('English', 'Writing', 'Informal Letter', 'Informal Letter Writing', false),
    -- WB Bengali ব্যাকরণ (Grammar)
    ('Bengali', 'ব্যাকরণ', 'সমাস', 'সমাস', false),
    ('Bengali', 'ব্যাকরণ', 'বাচ্য পরিবর্তন', 'বাচ্য পরিবর্তন', false),
    ('Bengali', 'ব্যাকরণ', 'বাক্য রূপান্তর', 'বাক্য রূপান্তর', false),
    ('Bengali', 'ব্যাকরণ', 'বাচ্য', 'বাচ্য পরিবর্তন', false),
    ('Bengali', 'ব্যাকরণ', 'পদের প্রকার', 'পদ প্রকরণ', false),
    ('Bengali', 'ব্যাকরণ', 'বিভক্তি', 'কারক ও অকারক সম্পর্ক', true),
    ('Bengali', 'ব্যাকরণ', 'বাক্যের শ্রেণীবিভাগ', 'বাক্য প্রকরণ', false),
    ('Bengali', 'ব্যাকরণ', 'পদের প্রকারভেদ', 'পদ প্রকরণ', false),
    ('Bengali', 'ব্যাকরণ', 'সমাসবদ্ধ শব্দ', 'সমাস', true),
    ('Bengali', 'ব্যাকরণ', 'বাক্যের প্রকার', 'বাক্য প্রকরণ', false),
    ('Bengali', 'ব্যাকরণ', 'তৎপুরুষ সমাস', 'সমাস', true),
    ('Bengali', 'ব্যাকরণ', 'পদবিন্যাস ও কারক বিশ্লেষণ', 'কারক ও অকারক সম্পর্ক', true),
    ('Bengali', 'ব্যাকরণ', 'বাক্য বিশ্লেষণ', 'বাক্য প্রকরণ', true),
    ('Bengali', 'ব্যাকরণ', 'কারক ও অনুসর্গ', 'কারক ও অকারক সম্পর্ক', false),
    ('Bengali', 'ব্যাকরণ', 'বাক্যে বাচ্য', 'বাচ্য পরিবর্তন', true),
    ('Bengali', 'ব্যাকরণ', 'বাক্যের উপাদান', 'বাক্য প্রকরণ', true),
    ('Bengali', 'ব্যাকরণ', 'বাক্যের গঠন', 'বাক্য প্রকরণ', true),
    ('Bengali', 'ব্যাকরণ', 'বাক্যের শ্রেণীবিন্যাস', 'বাক্য প্রকরণ', false),
    ('Bengali', 'ব্যাকরণ', 'সমাসের প্রকারভেদ', 'সমাস', false),
    ('Bengali', 'ব্যাকরণ', 'Voice (ভাববাচ্য)', 'বাচ্য পরিবর্তন', false),
    ('Bengali', 'ব্যাকরণ', 'Compound Words (সমাস)', 'সমাস', false),
    ('Bengali', 'ব্যাকরণ', 'কারক ও বিভক্তি', 'কারক ও অকারক সম্পর্ক', false),
    ('Bengali', 'ব্যাকরণ', 'কারক ও অনুসর্গসমূহ', 'কারক ও অকারক সম্পর্ক', false),
    ('Bengali', 'ব্যাকরণ', 'কারক চিহ্ন', 'কারক ও অকারক সম্পর্ক', true),
    ('Bengali', 'ব্যাকরণ', 'কারক চিহ্নিতকরণ', 'কারক ও অকারক সম্পর্ক', true),
    ('Bengali', 'ব্যাকরণ', 'কারক নির্দেশক', 'কারক ও অকারক সম্পর্ক', true),
    ('Bengali', 'ব্যাকরণ', 'কারক নির্ধারণ', 'কারক ও অকারক সম্পর্ক', true),
    ('Bengali', 'ব্যাকরণ', 'কারকের বিশ্লেষণ', 'কারক ও অকারক সম্পর্ক', true),
    -- WB Bengali রচনা (Composition)
    ('Bengali', 'রচনা', 'বর্ণনামূলক রচনা', 'প্রবন্ধ রচনা', true)
),
run_scope as (
  select distinct a.run_id,
    a.education_context->>'subject_or_course' as subject
  from archetypes a
  where a.education_context->'curriculum_source'->>'name' = 'West Bengal Board'
    and a.education_context->>'grade_or_year' = '10'
    and a.education_context->>'subject_or_course' in ('English', 'Bengali')
),
target_rows as (
  select s.run_id, s.question_id, m.real_topic, m.keep_topic,
    s.signature->'curriculum'->>'topic' as orig_topic
  from archetype_question_signatures s
  join run_scope rs on rs.run_id = s.run_id
  join mapping m on m.subject = rs.subject
    and lower(trim(s.signature->'curriculum'->>'chapter')) = lower(trim(m.shared_chapter))
    and s.signature->'curriculum'->>'topic' = m.mined_topic
)
update archetype_question_signatures s
set signature = jsonb_set(
  jsonb_set(s.signature, '{curriculum,chapter}', to_jsonb(tr.real_topic)),
  '{curriculum,topic}', case when tr.keep_topic then to_jsonb(tr.orig_topic) else 'null'::jsonb end
)
from target_rows tr
where s.run_id = tr.run_id and s.question_id = tr.question_id;
