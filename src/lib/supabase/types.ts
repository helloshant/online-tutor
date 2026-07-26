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
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  created_at: string;
  activated_at: string | null;
};

export type SubscriptionSubject = {
  id: string;
  subscription_id: string;
  subject_id: string;
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
// supabase/migrations/0005_answer_bank.sql and 0006_answer_bank_validation.sql.
// The admin panel reads/updates/deletes this table through the ordinary
// session (RLS + is_admin()), same pattern as the syllabus catalog tables;
// it never inserts into it.
export type AnsweredQuestion = {
  id: string;
  board_id: string;
  grade_id: string;
  subject_id: string;
  medium: Medium;
  question: string;
  answer: string;
  validation_status: AnswerValidationStatus;
  hit_count: number;
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
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
}
