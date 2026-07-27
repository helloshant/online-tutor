-- Reverses 0010_topic_exercises.sql: the hand-curated, admin-authored
-- exercises feature is being replaced by an LLM-generated topic summary
-- plus an answer-bank-backed "relevant exercises" search (see
-- 0013_topic_summaries_and_exercise_search.sql).
drop table if exists public.topic_exercises;
