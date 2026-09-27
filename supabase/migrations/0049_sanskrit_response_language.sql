-- Sanskrit is a language subject like Hindi/Bengali (its own class should
-- always be conducted in Sanskrit, regardless of the student's own medium
-- cohort -- see FIXED_RESPONSE_LANGUAGE_SUBJECT in src/lib/studentScope.ts),
-- but unlike Hindi/Bengali it was never a valid `medium` value anywhere,
-- since `medium` doubles as "which student cohort" (subscriptions,
-- syllabus_topics, chat_messages, broadcasts, practice_papers -- genuinely
-- always English/Hindi/Bengali, untouched here) and, for exactly two tables,
-- "what language was this chat exchange conducted in" (chat_events.medium
-- and answered_questions.medium, both written directly from
-- responseLanguage in services/orchestrator/src/server.ts, not from the
-- student's own cohort medium). Only those two tables' constraints need
-- 'Sanskrit' added -- content/cohort scoping (resolveContentMedium) stays
-- exactly as-is, since Sanskrit syllabus content itself is still authored
-- under a real cohort medium (English, today), only the tutor's own reply
-- language changes.
alter table chat_events drop constraint chat_events_medium_check;
alter table chat_events add constraint chat_events_medium_check
  check (medium in ('English', 'Hindi', 'Bengali', 'Sanskrit'));

alter table answered_questions drop constraint answered_questions_medium_check;
alter table answered_questions add constraint answered_questions_medium_check
  check (medium in ('English', 'Hindi', 'Bengali', 'Sanskrit'));
