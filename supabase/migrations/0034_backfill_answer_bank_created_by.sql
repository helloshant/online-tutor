-- One-time, best-effort backfill of answered_questions.created_by for rows
-- written before 0033_answer_bank_created_by.sql added the column (so
-- recordAnswer/bulkImportAnswers never had it to populate). There's no
-- direct record of who caused an old row to exist, so this correlates each
-- one back to the chat_events row (source = 'llm', the only source that
-- ever leads to a fresh answer-bank write) that must have produced it --
-- same board/grade/subject/medium scope, matching question text, and the
-- closest chat_events row in time (observed diffs are sub-second: both
-- writes fire from the same request, milliseconds apart).
--
-- Two shapes of question text need two matching strategies, because
-- chat_events.question isn't always the literal answered_questions.question:
--   - Plain chat answers: chat_events.question *is* the student's question
--     (pre-restatement rows only -- this backfill only ever reaches rows
--     that predate the restatement feature entirely, so the raw text still
--     matches exactly).
--   - Topic-exercises batches: one topic-exercises request produces several
--     answered_questions rows (one per generated exercise), but chat_events
--     records a single synthetic "topic-exercises: <chapter> / <topic>"
--     descriptor for the whole request, not each exercise's own text. That
--     descriptor is reconstructed here from syllabus_topics via the row's
--     topic_id to match it back -- a legitimate many-answered_questions to
--     one-chat_event correlation, not a bug in the join.
--
-- Rows with no matching chat_events row -- overwhelmingly admin bulk
-- imports, which never had a chat_events row to begin with -- are left
-- untouched; there's nothing to correlate them against. Safe to re-run:
-- only touches created_by is null rows, and a second run simply finds
-- nothing left to match.
with candidates as (
  select
    aq.id as answered_question_id,
    ce.user_id,
    abs(extract(epoch from (aq.created_at - ce.created_at))) as diff_seconds
  from public.answered_questions aq
  join public.chat_events ce
    on ce.source = 'llm'
    and ce.board_id = aq.board_id
    and ce.grade_id = aq.grade_id
    and ce.subject_id = aq.subject_id
    and ce.medium = aq.medium
    and ce.question = aq.question
  where aq.created_by is null
    and aq.topic_id is null

  union all

  select
    aq.id as answered_question_id,
    ce.user_id,
    abs(extract(epoch from (aq.created_at - ce.created_at))) as diff_seconds
  from public.answered_questions aq
  join public.syllabus_topics st on st.id = aq.topic_id
  join public.chat_events ce
    on ce.source = 'llm'
    and ce.board_id = aq.board_id
    and ce.grade_id = aq.grade_id
    and ce.subject_id = aq.subject_id
    and ce.medium = aq.medium
    and ce.question = 'topic-exercises: ' || st.chapter || ' / ' || st.topic
  where aq.created_by is null
    and aq.topic_id is not null
),
-- Per answered_questions row, keep only its single closest chat_events
-- match -- duplicate 'llm' events for the exact same question text can
-- exist (e.g. the same question asked again while the first answer was
-- still pending_review, before it was servable), so nearest-in-time is the
-- disambiguator, same as the observability drilldown already relies on
-- proximity rather than an explicit FK between the two tables.
ranked as (
  select *, row_number() over (partition by answered_question_id order by diff_seconds) as rn
  from candidates
)
update public.answered_questions aq
set created_by = r.user_id
from ranked r
where r.answered_question_id = aq.id
  and r.rn = 1
  -- Generous relative to the sub-second diffs actually observed -- guards
  -- against ever attributing a row to a coincidentally-matching but
  -- unrelated chat_events row far away in time, without being so tight it
  -- misses a legitimately slow request.
  and r.diff_seconds <= 60;
