-- ---------------------------------------------------------------------------
-- Adds a language dimension to topic_summaries so the English subject's
-- syllabus (now always stored under medium = 'English' -- see the syllabus-
-- scoping change alongside this migration in dashboard-shell.tsx and
-- /api/chat/route.ts) can still be summarized in a student's own native
-- medium, distinctly stored, cached, and admin-approved per topic *and*
-- language -- not just regenerated fresh and thrown away every time, the
-- way a one-off LLM translation would be.
--
-- Every other subject's syllabus stays authored per-medium (see
-- "Medium-scoped syllabus storage" in the README), so for those a topic's
-- summary language and its medium are always the same value -- this column
-- is a genuine no-op there, same as responseLanguage already is for chat.
-- ---------------------------------------------------------------------------

alter table public.topic_summaries add column language text;

-- Backfill: every summary generated before this migration was written in
-- its topic's own medium (there was no responseLanguage-aware persistence
-- path yet -- see the /v1/topic-summary rewrite in server.ts alongside this
-- migration), so that's the correct historical value for each existing row.
update public.topic_summaries ts
set language = st.medium
from public.syllabus_topics st
where st.id = ts.topic_id;

alter table public.topic_summaries alter column language set not null;

-- One summary per topic *per language* now, not one per topic -- a topic
-- can have both an English-language row (its own real medium) and a
-- Bengali-language row (a native-medium student's toggle-off default)
-- coexisting, each independently reviewable.
alter table public.topic_summaries drop constraint topic_summaries_topic_id_key;
alter table public.topic_summaries add constraint topic_summaries_topic_id_language_key unique (topic_id, language);
