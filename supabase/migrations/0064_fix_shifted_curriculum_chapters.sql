-- Data fix, not a schema change: corrects archetype_question_signatures
-- rows mined with curriculum.chapter/topic shifted by one level --
-- confirmed live for CBSE Grade 12 Physical Education, where every row
-- shares the exact same degenerate chapter value ("Physical Education",
-- the subject name) with the REAL chapter name sitting in curriculum.topic
-- instead (e.g. topic: "Management of Sporting Events") -- see
-- services/orchestrator/src/archetypeExercises.ts's own comment on why
-- this broke the sub-topic picker (every PE chapter's picker showed every
-- OTHER PE chapter's name as a "sub-topic", since the targetChapter
-- fallback match there treats any row sharing that one degenerate value
-- as relevant to every chapter at once).
--
-- Only touches rows where BOTH (a) curriculum.chapter normalizes to
-- exactly "Physical Education" and (b) curriculum.topic normalizes to
-- EXACTLY one of this subject's real syllabus_topics.topic values --
-- deliberately strict/conservative, no fuzzy matching, so nothing gets
-- reclassified on a guess. Sets chapter to the real chapter name and
-- topic to NULL (no genuine within-chapter concept was ever captured for
-- these rows -- honest absence, not a fabricated one; see
-- archetypeExercises.ts's chapterByQuestion, updated in the same change
-- to treat a null topic as "chapter known, no finer concept" rather than
-- dropping the row from chapter-level matching entirely).
--
-- Scoped to this one subject only right now -- the same shifted-by-one-
-- level pattern also affects West Bengal Board Grade 10 Geography, but
-- its real syllabus topic names are bilingual ("বর্জ্য ব্যবস্থাপনা (Waste
-- Management)") while the mined data has Bengali-only/English-only
-- variants that don't byte-match them even after case/trim normalization
-- (confirmed: a naive exact-match found 0 rows there). Fixing that
-- reliably needs the same Unicode-safe matching this app's own
-- curriculum-reconciliation tool (services/archetype-miner/src/
-- curriculumReconciliation.ts) already handles -- deliberately left for
-- that tool to run against, rather than hand-rolling a fuzzy SQL match
-- that risks silently mismapping Bengali text here.
with run_scope as (
  select distinct a.run_id
  from archetypes a
  where a.education_context->'curriculum_source'->>'name' = 'CBSE'
    and a.education_context->>'subject_or_course' = 'Physical Education'
    and a.education_context->>'grade_or_year' = '12'
),
real_names as (
  select st.topic as real_name
  from syllabus_topics st
  join boards b on b.id = st.board_id
  join grades g on g.id = st.grade_id
  join subjects sub on sub.id = st.subject_id
  where b.name = 'CBSE' and g.name = 'Grade 12' and sub.name = 'Physical Education'
),
target_rows as (
  select s.run_id, s.question_id, rn.real_name
  from archetype_question_signatures s
  join run_scope rs on rs.run_id = s.run_id
  join real_names rn on lower(trim(rn.real_name)) = lower(trim(s.signature->'curriculum'->>'topic'))
  where lower(trim(s.signature->'curriculum'->>'chapter')) = lower(trim('Physical Education'))
)
update archetype_question_signatures s
set signature = jsonb_set(
  jsonb_set(s.signature, '{curriculum,chapter}', to_jsonb(tr.real_name)),
  '{curriculum,topic}', 'null'::jsonb
)
from target_rows tr
where s.run_id = tr.run_id and s.question_id = tr.question_id;
