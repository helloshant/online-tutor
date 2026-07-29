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

// Admin-generated, single-use-overall codes that bypass payment entirely
// (src/app/subscribe/actions.ts's redeemCoupon) -- see
// supabase/migrations/0019_ccavenue_and_coupons.sql. used_by/used_at/
// subscription_id are all null until redeemed; once set, the code is
// permanently spent (not a per-student-once code shared among many people).
export type CouponCode = {
  id: string;
  code: string;
  created_by: string;
  used_by: string | null;
  used_at: string | null;
  subscription_id: string | null;
  created_at: string;
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
  // A supporting figure/diagram for this question, admin-attached after the
  // fact (src/app/admin/answer-bank/actions.ts's setImage/removeImage) --
  // never set by any LLM-generation path. Public Supabase Storage URL, see
  // 0017_answer_bank_image.sql.
  image_url: string | null;
  created_at: string;
  last_used_at: string;
};

export type ChatEventMode = "student" | "staff";
export type ChatEventSource = "cache" | "database" | "llm" | "rejected";

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

export type AdminPageKey = "users" | "catalog" | "answer_bank" | "observability" | "coupons";

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
