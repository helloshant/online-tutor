-- One-time cleanup of a catalog duplication created by a bulk chapter-notes
-- import (src/app/admin/chapter-notes/actions.ts, importChapterChunksJson):
-- the import was run with "Mathematics" typed into the "book" field rather
-- than one distinct chapter at a time. Since no syllabus_topics row already
-- existed under a chapter literally named "Mathematics", the import
-- auto-created 14 brand-new topic rows there (one per chapter_title in the
-- JSON, e.g. chapter='Mathematics', topic='Real Numbers') instead of
-- matching the catalog's existing, correctly-structured rows (e.g.
-- chapter='Real Numbers', topic='Euclid's division lemma, fundamental
-- theorem of arithmetic') -- hence /admin/chapter-notes' "Ingestion
-- coverage" reporting those existing rows as still-missing, and the
-- dashboard syllabus sidebar (which groups by `chapter`) showing a
-- spurious "Mathematics" heading with 14 flat chapter names alongside the
-- real ones. This never affected chat itself -- match_chapter_chunks
-- retrieval is scoped by board/grade/subject/medium only, not topic_id
-- (see 0024_chapter_documents_rag.sql) -- only the catalog labeling/UI.
--
-- Scoped explicitly to CBSE Grade 10 Mathematics (English) by name rather
-- than by hardcoded row IDs, matching this table's actual current
-- footprint (chapter='Mathematics' exists nowhere else): confirmed via
-- direct query before writing this migration.
--
-- Two outcomes, decided per chapter with the admin (2026-08-24):
--   1. Six chapters (Real Numbers, Polynomials, Pair of Linear Equations
--      in Two Variables, Quadratic Equations, Arithmetic Progressions,
--      Circles) already had a correctly-structured syllabus_topics row --
--      the newly-imported content is relinked onto that existing row, and
--      the duplicate placeholder row is removed once nothing references it.
--   2. The other eight (including "Introduction to Trigonometry" and "Some
--      Applications of Trigonometry", deliberately kept as their own two
--      chapters rather than merged into the catalog's existing single
--      "Trigonometry" topic -- the admin's explicit choice, since that
--      existing entry covers overlapping-but-distinct ground) had no
--      existing counterpart at all -- their placeholder row is kept, just
--      relabeled with its own topic text as the chapter, promoting it into
--      a proper single-topic chapter instead of sitting under the bogus
--      "Mathematics" heading.
with scope as (
  select
    b.id as board_id, g.id as grade_id, s.id as subject_id
  from public.boards b, public.grades g, public.subjects s
  where b.name = 'CBSE' and g.name = 'Grade 10' and s.name = 'Mathematics'
),
dup as (
  select st.id as dup_topic_id, st.topic, st.board_id, st.grade_id, st.subject_id, st.medium
  from public.syllabus_topics st, scope
  where st.chapter = 'Mathematics'
    and st.board_id = scope.board_id
    and st.grade_id = scope.grade_id
    and st.subject_id = scope.subject_id
    and st.medium = 'English'
),
correct as (
  select st.id as correct_topic_id, st.chapter, st.board_id, st.grade_id, st.subject_id, st.medium
  from public.syllabus_topics st, scope
  where st.chapter <> 'Mathematics'
    and st.board_id = scope.board_id
    and st.grade_id = scope.grade_id
    and st.subject_id = scope.subject_id
    and st.medium = 'English'
),
mapping as (
  select d.dup_topic_id, c.correct_topic_id
  from dup d
  join correct c
    on c.chapter = d.topic
    and c.board_id = d.board_id
    and c.grade_id = d.grade_id
    and c.subject_id = d.subject_id
    and c.medium = d.medium
)
-- Step 1a: relink the chunked/embedded pieces first (child of
-- chapter_documents, and the table retrieval actually queries).
update public.chapter_document_chunks cc
set topic_id = m.correct_topic_id
from mapping m
where cc.topic_id = m.dup_topic_id;

with scope as (
  select b.id as board_id, g.id as grade_id, s.id as subject_id
  from public.boards b, public.grades g, public.subjects s
  where b.name = 'CBSE' and g.name = 'Grade 10' and s.name = 'Mathematics'
),
dup as (
  select st.id as dup_topic_id, st.topic, st.board_id, st.grade_id, st.subject_id, st.medium
  from public.syllabus_topics st, scope
  where st.chapter = 'Mathematics'
    and st.board_id = scope.board_id
    and st.grade_id = scope.grade_id
    and st.subject_id = scope.subject_id
    and st.medium = 'English'
),
correct as (
  select st.id as correct_topic_id, st.chapter, st.board_id, st.grade_id, st.subject_id, st.medium
  from public.syllabus_topics st, scope
  where st.chapter <> 'Mathematics'
    and st.board_id = scope.board_id
    and st.grade_id = scope.grade_id
    and st.subject_id = scope.subject_id
    and st.medium = 'English'
),
mapping as (
  select d.dup_topic_id, c.correct_topic_id
  from dup d
  join correct c
    on c.chapter = d.topic
    and c.board_id = d.board_id
    and c.grade_id = d.grade_id
    and c.subject_id = d.subject_id
    and c.medium = d.medium
)
-- Step 1b: relink the parent document rows the same way.
update public.chapter_documents cd
set topic_id = m.correct_topic_id
from mapping m
where cd.topic_id = m.dup_topic_id;

with scope as (
  select b.id as board_id, g.id as grade_id, s.id as subject_id
  from public.boards b, public.grades g, public.subjects s
  where b.name = 'CBSE' and g.name = 'Grade 10' and s.name = 'Mathematics'
)
-- Step 2: for the eight placeholder rows with no existing catalog
-- counterpart, promote them into their own proper chapter in place --
-- topic_id (and therefore every FK to it) is untouched, only the
-- mislabeled `chapter` column changes.
update public.syllabus_topics st
set chapter = st.topic
from scope
where st.chapter = 'Mathematics'
  and st.board_id = scope.board_id
  and st.grade_id = scope.grade_id
  and st.subject_id = scope.subject_id
  and st.medium = 'English'
  and not exists (
    select 1 from public.syllabus_topics c
    where c.chapter = st.topic
      and c.board_id = st.board_id
      and c.grade_id = st.grade_id
      and c.subject_id = st.subject_id
      and c.medium = st.medium
  );

with scope as (
  select b.id as board_id, g.id as grade_id, s.id as subject_id
  from public.boards b, public.grades g, public.subjects s
  where b.name = 'CBSE' and g.name = 'Grade 10' and s.name = 'Mathematics'
)
-- Step 3: the six placeholder rows that got relinked in step 1 are now
-- pure duplicates -- nothing references their topic_id any more (checked
-- by construction: chapter_documents/chapter_document_chunks were already
-- moved off them) -- and their chapter still reads 'Mathematics' (step 2
-- skipped them, since a real counterpart exists), so remove them.
delete from public.syllabus_topics st
using scope
where st.chapter = 'Mathematics'
  and st.board_id = scope.board_id
  and st.grade_id = scope.grade_id
  and st.subject_id = scope.subject_id
  and st.medium = 'English'
  and exists (
    select 1 from public.syllabus_topics c
    where c.chapter = st.topic
      and c.board_id = st.board_id
      and c.grade_id = st.grade_id
      and c.subject_id = st.subject_id
      and c.medium = st.medium
      and c.id <> st.id
  );
