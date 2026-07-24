export type Medium = "English" | "Hindi" | "Bengali";
export type SubscriptionStatus =
  | "pending_payment"
  | "active"
  | "cancelled"
  | "expired";
export type ProfileRole = "user" | "admin";
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
  subscription_id: string;
  subject_id: string;
  role: ChatRole;
  content: string;
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
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
}
