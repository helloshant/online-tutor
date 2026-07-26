-- A board's syllabus isn't always a mechanical translation across mediums
-- of instruction: West Bengal Board's official Bengali-medium syllabus, for
-- example, is authored in Bengali and isn't guaranteed to line up
-- chapter-for-chapter with an English-medium version. Previously
-- syllabus_topics had exactly one syllabus per (board, grade, subject),
-- shown to every subscriber regardless of medium. This adds medium as a
-- fourth scoping dimension, so admins can enter each medium's syllabus
-- straight from its own authoritative source.

alter table public.syllabus_topics
  add column medium text check (medium in ('English', 'Hindi', 'Bengali'));

-- Backfill: all syllabus data entered before this migration was authored in
-- English (see 0003_seed_catalog.sql). Existing rows become the English
-- syllabus; admins add Hindi/Bengali syllabi as new rows going forward.
update public.syllabus_topics set medium = 'English' where medium is null;

alter table public.syllabus_topics alter column medium set not null;

alter table public.syllabus_topics
  drop constraint syllabus_topics_board_id_grade_id_subject_id_chapter_topic_key;
alter table public.syllabus_topics
  add constraint syllabus_topics_board_grade_subject_medium_chapter_topic_key
    unique (board_id, grade_id, subject_id, medium, chapter, topic);

drop index if exists syllabus_topics_scope_idx;
create index syllabus_topics_scope_idx
  on public.syllabus_topics (board_id, grade_id, subject_id, medium, sort_order);
