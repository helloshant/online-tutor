-- Staff (admin/superadmin) have never needed a subscription to chat
-- (0004_superadmin_and_staff_access.sql lets subscription_id be null for
-- them), and until now that meant staff chat was always the single
-- unrestricted "ask anything" mode -- there was no board/grade concept for
-- staff at all, so one null-subscription thread per subject was enough.
--
-- Staff can now optionally "preview" a specific board/grade/medium to see
-- exactly what a student under that combination experiences (syllabus
-- scoping, RAG grounding, the answer bank -- see /api/chat/route.ts's
-- resolveStaffPreviewScope). That reintroduces the same board/grade/medium
-- dimension a real student's subscription_id already carries -- without
-- somewhere to record it, a staff member's chat_messages rows would still
-- only ever be scoped by (user_id, subject_id, subscription_id IS NULL),
-- which would mix together conversations from every board/grade they've
-- ever previewed (plus the unrestricted mode) into one indistinguishable
-- thread -- actively misleading for the thing this feature exists to test.
--
-- Nullable and populated for staff-preview rows only:
--   - a real student's rows leave these null -- subscription_id already
--     unambiguously identifies their board/grade/medium, so denormalizing
--     it again here would earn nothing.
--   - staff rows in unrestricted mode (no preview active) also leave these
--     null, exactly matching today's existing rows -- unaffected by this
--     migration.
--   - staff rows written while previewing a specific board/grade/medium
--     get all three set, so that preview's history stays its own thread,
--     separate from every other board/grade preview and from unrestricted
--     mode.
alter table public.chat_messages
  add column board_id uuid references public.boards (id) on delete set null,
  add column grade_id uuid references public.grades (id) on delete set null,
  add column medium text check (medium in ('English', 'Hindi', 'Bengali'));

-- Serves the staff-preview history query directly (user_id, subject_id,
-- board_id, grade_id, medium) -- chat_messages_user_subject_idx already
-- covers the ordinary student/unrestricted-staff case.
create index chat_messages_staff_preview_idx
  on public.chat_messages (user_id, subject_id, board_id, grade_id, medium);
