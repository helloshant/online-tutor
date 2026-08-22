export type Medium = "English" | "Hindi" | "Bengali";
export type SubscriptionStatus =
  | "pending_payment"
  | "active"
  | "cancelled"
  | "expired";
export type ProfileRole = "user" | "admin" | "superadmin";
export type ChatRole = "user" | "assistant";

// Plain `type` object literals (not `interface`) — Supabase's client types
// check `Row extends Record<string, unknown>` structurally, which
// `interface` declarations fail (TS doesn't credit them with an implicit
// index signature the way it does fresh object type literals).
export type Profile = {
  id: string;
  full_name: string | null;
  role: ProfileRole;
  // Null for an OAuth-only (Google) account -- it has no password with this
  // app to expire. Set at signup for a native account and re-stamped on
  // every password change (see 0011_password_lifecycle.sql).
  password_changed_at: string | null;
  created_at: string;
  // Where this signup came from -- captured as a first-touch cookie by
  // src/proxy.ts (?utm_source=/?ref=, ?utm_campaign=) and written at
  // account-creation time (src/app/signup/actions.ts for native signup,
  // src/app/auth/callback/route.ts for Google). Null for any account that
  // predates this (0022_signup_source.sql) or arrived with no tracking
  // params at all.
  signup_source: string | null;
  signup_campaign: string | null;
};

export type Board = {
  id: string;
  name: string;
  code: string;
  created_at: string;
};

export type Grade = {
  id: string;
  name: string;
  level: number;
  created_at: string;
};

export type Subject = {
  id: string;
  name: string;
  code: string;
  created_at: string;
};

export type BoardGradeSubject = {
  id: string;
  board_id: string;
  grade_id: string;
  subject_id: string;
};

export type SyllabusTopic = {
  id: string;
  board_id: string;
  grade_id: string;
  subject_id: string;
  // The syllabus is scoped per medium, not just per board/grade/subject --
  // a board's official vernacular syllabus (e.g. West Bengal Board's
  // Bengali-medium document) isn't guaranteed to be a translation of its
  // English-medium one.
  medium: Medium;
  chapter: string;
  topic: string;
  sort_order: number;
  created_at: string;
};

export type Subscription = {
  id: string;
  user_id: string;
  board_id: string;
  grade_id: string;
  medium: Medium;
  status: SubscriptionStatus;
  amount_paise: number | null;
  // CCAvenue's own transaction reference, recorded after a successful
  // payment (src/app/api/ccavenue/callback/route.ts) -- null for a
  // subscription activated via a coupon code or an admin's
  // activateSubscriptionWithoutPayment, so a paid subscription stays
  // distinguishable in the data from one that wasn't. No separate
  // "order id" column: CCAvenue's order_id is just this row's own id (see
  // src/app/api/ccavenue/initiate/route.ts).
  ccavenue_tracking_id: string | null;
  created_at: string;
  activated_at: string | null;
};

export type SubscriptionSubject = {
  id: string;
  subscription_id: string;
  subject_id: string;
};

// Admin-generated, single-use-overall discount codes (src/app/subscribe/
// actions.ts's redeemCoupon) -- see supabase/migrations/0019_ccavenue_and_
// coupons.sql and 0021_coupon_discount_percent.sql. used_by/used_at/
// subscription_id are all null until redeemed; once set, the code is
// permanently spent (not a per-student-once code shared among many people).
// discount_percent of 100 reproduces the original "bypass payment entirely"
// behavior; anything less reduces the subscription's amount_paise instead.
export type CouponCode = {
  id: string;
  code: string;
  created_by: string;
  used_by: string | null;
  used_at: string | null;
  subscription_id: string | null;
  created_at: string;
  expires_at: string | null;
  discount_percent: number;
};

export type ChatMessage = {
  id: string;
  user_id: string;
  // Null for staff (admin/superadmin) chats, which aren't tied to a
  // subscription -- staff never subscribe or pay.
  subscription_id: string | null;
  subject_id: string;
  role: ChatRole;
  content: string;
  created_at: string;
};

export type AnswerValidationStatus = "auto_approved" | "pending_review" | "admin_approved" | "rejected";

// Written only by the orchestrator service (service-role key) -- see
// supabase/migrations/0005_answer_bank.sql, 0006_answer_bank_validation.sql,
// 0015_answer_bank_topic_id.sql, and 0016_answer_bank_tags.sql. RLS is
// enabled with zero client-facing policies (a deliberate backend-only
// table, see 0005), so the admin panel reads/updates/deletes it with the
// service-role client too -- there is no ordinary-session path to this
// table at all. Admins can also write to it directly now, via tagging and
// bulk import (src/app/admin/answer-bank), both using the same
// service-role client.
export type AnsweredQuestion = {
  id: string;
  board_id: string;
  grade_id: string;
  subject_id: string;
  // Set only for entries created by the topic-exercises generation flow --
  // an ordinary chat-answered question has no syllabus topic concept, only
  // a board/grade/subject/medium scope.
  topic_id: string | null;
  medium: Medium;
  question: string;
  answer: string;
  validation_status: AnswerValidationStatus;
  hit_count: number;
  // Free-form provenance labels an admin assigns (e.g. a textbook or exam
  // paper name) -- never set by the LLM-generation paths, only by admin
  // tagging/bulk-import. Always an array, never null (column default '{}').
  tags: string[];
  // Supporting figures/diagrams for this question, admin-attached after the
  // fact (src/app/admin/answer-bank/actions.ts's addImage/removeImage) --
  // never set by any LLM-generation path. Public Supabase Storage URLs, in
  // display order (oldest-appended-first). Always an array, never null
  // (column default '{}'), see 0017_answer_bank_image.sql and
  // 0023_answer_bank_multiple_images.sql.
  image_urls: string[];
  created_at: string;
  last_used_at: string;
};

export type ChatEventMode = "student" | "staff";
// "chapter_notes" is a topic-summary served straight from admin-authored
// chapter content -- see services/orchestrator/src/server.ts's
// /v1/topic-summary handler.
export type ChatEventSource = "cache" | "database" | "llm" | "rejected" | "chapter_notes";

// Written only by the observability service (service-role key) -- see
// supabase/migrations/0007_chat_events.sql. The admin panel reads this
// table through the ordinary session (RLS + is_admin()), same pattern as
// the syllabus catalog and answer bank tables; it never writes to it.
export type ChatEvent = {
  id: string;
  user_id: string;
  mode: ChatEventMode;
  board_id: string | null;
  grade_id: string | null;
  subject_id: string;
  medium: Medium | null;
  question: string;
  source: ChatEventSource;
  provider: string | null;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  answer_bank_id: string | null;
  latency_ms: number | null;
  created_at: string;
};

export type AdminPageKey =
  | "users"
  | "catalog"
  | "answer_bank"
  | "observability"
  | "coupons"
  | "chapter_notes"
  | "topic_summaries"
  | "broadcasts";

// Written by superadmins only (RLS: is_superadmin() for all writes; a user
// can read their own rows to render their own nav). See
// supabase/migrations/0008_admin_page_permissions.sql. Superadmins are
// never gated by this table -- their access is always full, enforced in
// application code (requireAdminPage() in src/lib/auth.ts), not by rows
// here.
export type AdminPagePermission = {
  id: string;
  user_id: string;
  page: AdminPageKey;
  created_at: string;
};

// Admin-authored detailed chapter content, retrievable by semantic
// similarity rather than keyword match -- see
// supabase/migrations/0024_chapter_documents_rag.sql. RLS is enabled with
// zero client-facing policies, same "backend-only table" posture as
// answered_questions: the admin panel (src/app/admin/chapter-notes) reads/
// writes it with the service-role client, there is no ordinary-session path
// to this table at all. The derived, embedded chapter_document_chunks table
// is never touched from this app -- only the orchestrator's own separate
// Supabase connection reads/writes it (same as topic_summaries), so it has
// no entry here.
export type ChapterDocument = {
  id: string;
  topic_id: string;
  title: string;
  content: string;
  created_by: string | null;
  created_at: string;
};

export type TopicSummaryValidationStatus = "pending_review" | "approved" | "rejected";

// One LLM-generated summary per syllabus topic (topic_id is unique) --
// see supabase/migrations/0013_topic_summaries_and_exercise_search.sql and
// 0026_topic_summary_review.sql. RLS previously had zero client-facing
// policies at all (only the orchestrator's own service-role connection
// touched this table); 0026 added admin-only select/update/delete policies
// so /admin/topic-summaries can review pending summaries through the
// ordinary session -- there's still no insert policy, since a row only
// ever originates from the orchestrator's LLM-generation path.
export type TopicSummary = {
  id: string;
  topic_id: string;
  summary: string;
  validation_status: TopicSummaryValidationStatus;
  created_at: string;
  updated_at: string;
};

// See supabase/migrations/0028_broadcast_service.sql. Same "backend-only
// table" posture as the types above -- RLS enabled, zero client-facing
// policies. Admin pages read/write these via createAdminClient() (like
// coupon_codes/answered_questions/topic_summaries already do); a student's
// own inbox/feedback/test reads and writes also go through Next.js API
// routes using the admin client, authenticated by the student's own
// session first -- never the ordinary RLS-scoped client. Only the two
// operations with real cross-cutting logic that shouldn't trust a client
// (resolving who a broadcast reaches, and scoring a submitted test) go
// through services/broadcast itself (see broadcastClient.ts).
export type BroadcastType = "announcement" | "promotion" | "feedback" | "test" | "exam";
export type BroadcastStatus = "draft" | "sent" | "closed";

export type Broadcast = {
  id: string;
  type: BroadcastType;
  title: string;
  body: string;
  board_id: string | null;
  grade_id: string | null;
  subject_id: string | null;
  medium: Medium | null;
  status: BroadcastStatus;
  // The uploaded exam question paper (type='exam' only) -- Storage
  // *paths* in the private `exam-files` bucket, not public URLs; resolved
  // to a short-lived signed URL server-side for whoever's authorized to
  // see them. Always empty for every other broadcast type.
  attachment_paths: string[];
  sent_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type BroadcastRecipient = {
  id: string;
  broadcast_id: string;
  user_id: string;
  read_at: string | null;
  created_at: string;
};

export type BroadcastFeedbackResponse = {
  id: string;
  broadcast_id: string;
  user_id: string;
  rating: number | null;
  comment: string | null;
  created_at: string;
};

export type TestQuestionType = "mcq" | "short_answer";

export type TestQuestion = {
  id: string;
  broadcast_id: string;
  question_type: TestQuestionType;
  question: string;
  options: string[] | null;
  correct_option: number | null;
  max_score: number;
  sort_order: number;
};

export type TestAttemptStatus = "in_progress" | "submitted" | "graded";

export type TestAttempt = {
  id: string;
  broadcast_id: string;
  user_id: string;
  status: TestAttemptStatus;
  started_at: string;
  submitted_at: string | null;
  total_score: number | null;
  max_possible_score: number | null;
};

export type TestAnswer = {
  id: string;
  attempt_id: string;
  question_id: string;
  selected_option: number | null;
  answer_text: string | null;
  is_correct: boolean | null;
  score: number | null;
};

// type='exam' broadcasts (0029_exam_broadcast_type.sql): unlike
// test_questions, there's no question_type/options/correct_option here --
// every exam question is inherently marked by a human against the
// student's uploaded answer sheet, nothing machine-answerable.
export type ExamQuestion = {
  id: string;
  broadcast_id: string;
  question: string;
  max_score: number;
  sort_order: number;
};

export type ExamSubmissionStatus = "submitted" | "graded";

export type ExamSubmission = {
  id: string;
  broadcast_id: string;
  user_id: string;
  file_paths: string[];
  status: ExamSubmissionStatus;
  total_score: number | null;
  max_possible_score: number | null;
  feedback: string | null;
  submitted_at: string;
};

// Per-question marks an admin assigns while grading one submission --
// mirrors test_answers' (attempt_id, question_id) shape, minus the
// selected_option/answer_text/is_correct columns that don't apply here
// (the actual response lives in ExamSubmission.file_paths, not per
// question).
export type ExamQuestionScore = {
  id: string;
  submission_id: string;
  question_id: string;
  score: number;
};

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: Partial<Profile>;
        Update: Partial<Profile>;
        Relationships: [];
      };
      boards: {
        Row: Board;
        Insert: Partial<Board>;
        Update: Partial<Board>;
        Relationships: [];
      };
      grades: {
        Row: Grade;
        Insert: Partial<Grade>;
        Update: Partial<Grade>;
        Relationships: [];
      };
      subjects: {
        Row: Subject;
        Insert: Partial<Subject>;
        Update: Partial<Subject>;
        Relationships: [];
      };
      board_grade_subjects: {
        Row: BoardGradeSubject;
        Insert: Partial<BoardGradeSubject>;
        Update: Partial<BoardGradeSubject>;
        Relationships: [
          { foreignKeyName: "board_grade_subjects_board_id_fkey"; columns: ["board_id"]; referencedRelation: "boards"; referencedColumns: ["id"] },
          { foreignKeyName: "board_grade_subjects_grade_id_fkey"; columns: ["grade_id"]; referencedRelation: "grades"; referencedColumns: ["id"] },
          { foreignKeyName: "board_grade_subjects_subject_id_fkey"; columns: ["subject_id"]; referencedRelation: "subjects"; referencedColumns: ["id"] },
        ];
      };
      syllabus_topics: {
        Row: SyllabusTopic;
        Insert: Partial<SyllabusTopic>;
        Update: Partial<SyllabusTopic>;
        Relationships: [
          { foreignKeyName: "syllabus_topics_board_id_fkey"; columns: ["board_id"]; referencedRelation: "boards"; referencedColumns: ["id"] },
          { foreignKeyName: "syllabus_topics_grade_id_fkey"; columns: ["grade_id"]; referencedRelation: "grades"; referencedColumns: ["id"] },
          { foreignKeyName: "syllabus_topics_subject_id_fkey"; columns: ["subject_id"]; referencedRelation: "subjects"; referencedColumns: ["id"] },
        ];
      };
      subscriptions: {
        Row: Subscription;
        Insert: Partial<Subscription>;
        Update: Partial<Subscription>;
        Relationships: [
          { foreignKeyName: "subscriptions_board_id_fkey"; columns: ["board_id"]; referencedRelation: "boards"; referencedColumns: ["id"] },
          { foreignKeyName: "subscriptions_grade_id_fkey"; columns: ["grade_id"]; referencedRelation: "grades"; referencedColumns: ["id"] },
        ];
      };
      subscription_subjects: {
        Row: SubscriptionSubject;
        Insert: Partial<SubscriptionSubject>;
        Update: Partial<SubscriptionSubject>;
        Relationships: [
          { foreignKeyName: "subscription_subjects_subscription_id_fkey"; columns: ["subscription_id"]; referencedRelation: "subscriptions"; referencedColumns: ["id"] },
          { foreignKeyName: "subscription_subjects_subject_id_fkey"; columns: ["subject_id"]; referencedRelation: "subjects"; referencedColumns: ["id"] },
        ];
      };
      coupon_codes: {
        Row: CouponCode;
        Insert: Partial<CouponCode>;
        Update: Partial<CouponCode>;
        Relationships: [
          { foreignKeyName: "coupon_codes_subscription_id_fkey"; columns: ["subscription_id"]; referencedRelation: "subscriptions"; referencedColumns: ["id"] },
        ];
      };
      chat_messages: {
        Row: ChatMessage;
        Insert: Partial<ChatMessage>;
        Update: Partial<ChatMessage>;
        Relationships: [
          { foreignKeyName: "chat_messages_subscription_id_fkey"; columns: ["subscription_id"]; referencedRelation: "subscriptions"; referencedColumns: ["id"] },
          { foreignKeyName: "chat_messages_subject_id_fkey"; columns: ["subject_id"]; referencedRelation: "subjects"; referencedColumns: ["id"] },
        ];
      };
      answered_questions: {
        Row: AnsweredQuestion;
        Insert: Partial<AnsweredQuestion>;
        Update: Partial<AnsweredQuestion>;
        Relationships: [
          { foreignKeyName: "answered_questions_board_id_fkey"; columns: ["board_id"]; referencedRelation: "boards"; referencedColumns: ["id"] },
          { foreignKeyName: "answered_questions_grade_id_fkey"; columns: ["grade_id"]; referencedRelation: "grades"; referencedColumns: ["id"] },
          { foreignKeyName: "answered_questions_subject_id_fkey"; columns: ["subject_id"]; referencedRelation: "subjects"; referencedColumns: ["id"] },
          { foreignKeyName: "answered_questions_topic_id_fkey"; columns: ["topic_id"]; referencedRelation: "syllabus_topics"; referencedColumns: ["id"] },
        ];
      };
      chat_events: {
        Row: ChatEvent;
        Insert: Partial<ChatEvent>;
        Update: Partial<ChatEvent>;
        Relationships: [
          { foreignKeyName: "chat_events_board_id_fkey"; columns: ["board_id"]; referencedRelation: "boards"; referencedColumns: ["id"] },
          { foreignKeyName: "chat_events_grade_id_fkey"; columns: ["grade_id"]; referencedRelation: "grades"; referencedColumns: ["id"] },
          { foreignKeyName: "chat_events_subject_id_fkey"; columns: ["subject_id"]; referencedRelation: "subjects"; referencedColumns: ["id"] },
          { foreignKeyName: "chat_events_answer_bank_id_fkey"; columns: ["answer_bank_id"]; referencedRelation: "answered_questions"; referencedColumns: ["id"] },
        ];
      };
      admin_page_permissions: {
        Row: AdminPagePermission;
        Insert: Partial<AdminPagePermission>;
        Update: Partial<AdminPagePermission>;
        Relationships: [];
      };
      topic_summaries: {
        Row: TopicSummary;
        Insert: Partial<TopicSummary>;
        Update: Partial<TopicSummary>;
        Relationships: [
          { foreignKeyName: "topic_summaries_topic_id_fkey"; columns: ["topic_id"]; referencedRelation: "syllabus_topics"; referencedColumns: ["id"] },
        ];
      };
      chapter_documents: {
        Row: ChapterDocument;
        Insert: Partial<ChapterDocument>;
        Update: Partial<ChapterDocument>;
        Relationships: [
          { foreignKeyName: "chapter_documents_topic_id_fkey"; columns: ["topic_id"]; referencedRelation: "syllabus_topics"; referencedColumns: ["id"] },
        ];
      };
      broadcasts: {
        Row: Broadcast;
        Insert: Partial<Broadcast>;
        Update: Partial<Broadcast>;
        Relationships: [
          { foreignKeyName: "broadcasts_board_id_fkey"; columns: ["board_id"]; referencedRelation: "boards"; referencedColumns: ["id"] },
          { foreignKeyName: "broadcasts_grade_id_fkey"; columns: ["grade_id"]; referencedRelation: "grades"; referencedColumns: ["id"] },
          { foreignKeyName: "broadcasts_subject_id_fkey"; columns: ["subject_id"]; referencedRelation: "subjects"; referencedColumns: ["id"] },
        ];
      };
      broadcast_recipients: {
        Row: BroadcastRecipient;
        Insert: Partial<BroadcastRecipient>;
        Update: Partial<BroadcastRecipient>;
        Relationships: [
          { foreignKeyName: "broadcast_recipients_broadcast_id_fkey"; columns: ["broadcast_id"]; referencedRelation: "broadcasts"; referencedColumns: ["id"] },
        ];
      };
      broadcast_feedback_responses: {
        Row: BroadcastFeedbackResponse;
        Insert: Partial<BroadcastFeedbackResponse>;
        Update: Partial<BroadcastFeedbackResponse>;
        Relationships: [
          { foreignKeyName: "broadcast_feedback_responses_broadcast_id_fkey"; columns: ["broadcast_id"]; referencedRelation: "broadcasts"; referencedColumns: ["id"] },
        ];
      };
      test_questions: {
        Row: TestQuestion;
        Insert: Partial<TestQuestion>;
        Update: Partial<TestQuestion>;
        Relationships: [
          { foreignKeyName: "test_questions_broadcast_id_fkey"; columns: ["broadcast_id"]; referencedRelation: "broadcasts"; referencedColumns: ["id"] },
        ];
      };
      test_attempts: {
        Row: TestAttempt;
        Insert: Partial<TestAttempt>;
        Update: Partial<TestAttempt>;
        Relationships: [
          { foreignKeyName: "test_attempts_broadcast_id_fkey"; columns: ["broadcast_id"]; referencedRelation: "broadcasts"; referencedColumns: ["id"] },
        ];
      };
      test_answers: {
        Row: TestAnswer;
        Insert: Partial<TestAnswer>;
        Update: Partial<TestAnswer>;
        Relationships: [
          { foreignKeyName: "test_answers_attempt_id_fkey"; columns: ["attempt_id"]; referencedRelation: "test_attempts"; referencedColumns: ["id"] },
          { foreignKeyName: "test_answers_question_id_fkey"; columns: ["question_id"]; referencedRelation: "test_questions"; referencedColumns: ["id"] },
        ];
      };
      exam_questions: {
        Row: ExamQuestion;
        Insert: Partial<ExamQuestion>;
        Update: Partial<ExamQuestion>;
        Relationships: [
          { foreignKeyName: "exam_questions_broadcast_id_fkey"; columns: ["broadcast_id"]; referencedRelation: "broadcasts"; referencedColumns: ["id"] },
        ];
      };
      exam_submissions: {
        Row: ExamSubmission;
        Insert: Partial<ExamSubmission>;
        Update: Partial<ExamSubmission>;
        Relationships: [
          { foreignKeyName: "exam_submissions_broadcast_id_fkey"; columns: ["broadcast_id"]; referencedRelation: "broadcasts"; referencedColumns: ["id"] },
        ];
      };
      exam_question_scores: {
        Row: ExamQuestionScore;
        Insert: Partial<ExamQuestionScore>;
        Update: Partial<ExamQuestionScore>;
        Relationships: [
          { foreignKeyName: "exam_question_scores_submission_id_fkey"; columns: ["submission_id"]; referencedRelation: "exam_submissions"; referencedColumns: ["id"] },
          { foreignKeyName: "exam_question_scores_question_id_fkey"; columns: ["question_id"]; referencedRelation: "exam_questions"; referencedColumns: ["id"] },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: {
      // admin.auth.admin.listUsers()/getUserById() don't reliably populate
      // each user's `identities` array -- this queries auth.identities
      // directly. See 0014_email_identity_check.sql.
      get_users_with_email_identity: {
        Args: { p_user_ids: string[] };
        Returns: { user_id: string; has_email_identity: boolean }[];
      };
      // Same full-text answer-bank lookup the orchestrator uses (see
      // services/orchestrator/src/answerBank.ts and
      // supabase/migrations/0005_answer_bank.sql) -- callable here too since
      // the admin client authenticates as service_role, the same role this
      // function is granted to, and bulk import uses it as a dedup check
      // before writing (src/app/admin/answer-bank/actions.ts).
      search_answer_bank: {
        Args: {
          p_board_id: string;
          p_grade_id: string;
          p_subject_id: string;
          p_medium: string;
          p_query: string;
          p_min_rank?: number;
        };
        Returns: { id: string; answer: string; rank: number }[];
      };
    };
  };
}
