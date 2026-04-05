// packages/database/src/types.ts
// This file will be replaced by Supabase CLI generated types.
// For now, define the shape manually to unblock development.

export type Database = {
  public: {
    Tables: {
      tenants: {
        Row: {
          id: string;
          name: string;
          email: string;
          phone: string | null;
          business_type: string;
          plan: string;
          calls_used_this_month: number;
          calls_limit: number;
          voicenter_credentials: string | null;
          whatsapp_credentials: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          email: string;
          phone?: string | null;
          business_type: string;
          plan: string;
          calls_used_this_month?: number;
          calls_limit: number;
          voicenter_credentials?: string | null;
          whatsapp_credentials?: string | null;
        };
        Update: {
          id?: string;
          name?: string;
          email?: string;
          phone?: string | null;
          business_type?: string;
          plan?: string;
          calls_used_this_month?: number;
          calls_limit?: number;
          voicenter_credentials?: string | null;
          whatsapp_credentials?: string | null;
        };
        Relationships: [];
      };
      users: {
        Row: {
          id: string;
          tenant_id: string;
          email: string;
          role: "owner" | "admin" | "viewer";
          created_at: string;
        };
        Insert: {
          id: string;
          tenant_id: string;
          email: string;
          role: "owner" | "admin" | "viewer";
        };
        Update: {
          tenant_id?: string;
          email?: string;
          role?: "owner" | "admin" | "viewer";
        };
        Relationships: [];
      };
      campaigns: {
        Row: {
          id: string;
          tenant_id: string;
          name: string;
          status: "draft" | "active" | "paused" | "completed";
          template_id: string | null;
          script: string;
          questions: Array<{ question: string; key: string; options?: string[] }>;
          whatsapp_followup_template: string | null;
          whatsapp_followup_link: string | null;
          schedule_days: string[];
          schedule_windows: Array<{ start: string; end: string }>;
          max_concurrent_calls: number;
          max_retry_attempts: number;
          retry_delay_minutes: number;
          webhook_enabled: boolean;
          webhook_secret_hash: string | null;
          webhook_source_label: string | null;
          webhook_payload_example: Record<string, unknown> | null;
          webhook_last_rotated_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          name: string;
          status?: string;
          template_id: string | null;
          script: string;
          questions: Array<{ question: string; key: string; options?: string[] }>;
          whatsapp_followup_template: string | null;
          whatsapp_followup_link: string | null;
          schedule_days: string[];
          schedule_windows: Array<{ start: string; end: string }>;
          max_concurrent_calls: number;
          max_retry_attempts: number;
          retry_delay_minutes: number;
          webhook_enabled?: boolean;
          webhook_secret_hash?: string | null;
          webhook_source_label?: string | null;
          webhook_payload_example?: Record<string, unknown> | null;
          webhook_last_rotated_at?: string | null;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          name?: string;
          status?: string;
          template_id?: string | null;
          script?: string;
          questions?: Array<{ question: string; key: string; options?: string[] }>;
          whatsapp_followup_template?: string | null;
          whatsapp_followup_link?: string | null;
          schedule_days?: string[];
          schedule_windows?: Array<{ start: string; end: string }>;
          max_concurrent_calls?: number;
          max_retry_attempts?: number;
          retry_delay_minutes?: number;
          webhook_enabled?: boolean;
          webhook_secret_hash?: string | null;
          webhook_source_label?: string | null;
          webhook_payload_example?: Record<string, unknown> | null;
          webhook_last_rotated_at?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      contacts: {
        Row: {
          id: string;
          tenant_id: string;
          phone: string;
          name: string | null;
          email: string | null;
          custom_fields: Record<string, unknown>;
          is_dnc: boolean;
          dnc_at: string | null;
          dnc_source: "manual" | "opt_out" | "national_registry" | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          phone: string;
          name?: string | null;
          email?: string | null;
          custom_fields?: Record<string, unknown>;
          is_dnc?: boolean;
          dnc_at?: string | null;
          dnc_source?: "manual" | "opt_out" | "national_registry" | null;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          phone?: string;
          name?: string | null;
          email?: string | null;
          custom_fields?: Record<string, unknown>;
          is_dnc?: boolean;
          dnc_at?: string | null;
          dnc_source?: "manual" | "opt_out" | "national_registry" | null;
        };
        Relationships: [];
      };
      campaign_contacts: {
        Row: {
          id: string;
          campaign_id: string;
          contact_id: string;
          tenant_id: string;
          status: "pending" | "queued" | "calling" | "completed" | "failed" | "no_answer" | "dnc";
          attempt_count: number;
          next_retry_at: string | null;
          call_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          campaign_id: string;
          contact_id: string;
          tenant_id: string;
          status?: string;
          attempt_count?: number;
          next_retry_at?: string | null;
          call_id?: string | null;
        };
        Update: {
          id?: string;
          campaign_id?: string;
          contact_id?: string;
          tenant_id?: string;
          status?: string;
          attempt_count?: number;
          next_retry_at?: string | null;
          call_id?: string | null;
        };
        Relationships: [];
      };
      calls: {
        Row: {
          id: string;
          tenant_id: string;
          campaign_id: string;
          contact_id: string;
          campaign_contact_id: string;
          voicenter_call_id: string | null;
          status: "initiated" | "ringing" | "connected" | "completed" | "failed" | "no_answer" | "dead_letter";
          failure_reason: string | null;
          started_at: string | null;
          ended_at: string | null;
          duration_seconds: number | null;
          recording_path: string | null;
          lead_score: number | null;
          lead_status: "hot" | "warm" | "cold" | "not_interested" | "callback" | null;
          qualification_answers: Record<string, string> | null;
          whatsapp_sent: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          campaign_id: string;
          contact_id: string;
          campaign_contact_id: string;
          voicenter_call_id?: string | null;
          status: "initiated" | "ringing" | "connected" | "completed" | "failed" | "no_answer" | "dead_letter";
          failure_reason?: string | null;
          started_at?: string | null;
          ended_at?: string | null;
          duration_seconds?: number | null;
          recording_path?: string | null;
          lead_score?: number | null;
          lead_status?: "hot" | "warm" | "cold" | "not_interested" | "callback" | null;
          qualification_answers?: Record<string, string> | null;
          whatsapp_sent?: boolean;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          campaign_id?: string;
          contact_id?: string;
          campaign_contact_id?: string;
          voicenter_call_id?: string | null;
          status?: "initiated" | "ringing" | "connected" | "completed" | "failed" | "no_answer" | "dead_letter";
          failure_reason?: string | null;
          started_at?: string | null;
          ended_at?: string | null;
          duration_seconds?: number | null;
          recording_path?: string | null;
          lead_score?: number | null;
          lead_status?: "hot" | "warm" | "cold" | "not_interested" | "callback" | null;
          qualification_answers?: Record<string, string> | null;
          whatsapp_sent?: boolean;
        };
        Relationships: [];
      };
      call_transcripts: {
        Row: {
          id: string;
          call_id: string;
          tenant_id: string;
          transcript: Array<{ role: string; text: string; timestamp: string }>;
          created_at: string;
        };
        Insert: {
          call_id: string;
          tenant_id: string;
          transcript: Array<{ role: string; text: string; timestamp: string }>;
        };
        Update: {
          call_id?: string;
          tenant_id?: string;
          transcript?: Array<{ role: string; text: string; timestamp: string }>;
        };
        Relationships: [];
      };
      templates: {
        Row: {
          id: string;
          tenant_id: string | null;
          name: string;
          business_type: string;
          script: string;
          questions: Array<{ question: string; key: string; options?: string[] }>;
          whatsapp_template: string | null;
          is_system: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id?: string | null;
          name: string;
          business_type: string;
          script: string;
          questions: Array<{ question: string; key: string; options?: string[] }>;
          whatsapp_template?: string | null;
          is_system?: boolean;
        };
        Update: {
          id?: string;
          tenant_id?: string | null;
          name?: string;
          business_type?: string;
          script?: string;
          questions?: Array<{ question: string; key: string; options?: string[] }>;
          whatsapp_template?: string | null;
          is_system?: boolean;
        };
        Relationships: [];
      };
      audit_log: {
        Row: {
          id: string;
          tenant_id: string;
          action: string;
          entity_type: string;
          entity_id: string | null;
          details: Record<string, unknown> | null;
          created_at: string;
        };
        Insert: {
          tenant_id: string;
          action: string;
          entity_type: string;
          entity_id: string | null;
          details: Record<string, unknown> | null;
        };
        Update: {
          tenant_id?: string;
          action?: string;
          entity_type?: string;
          entity_id?: string | null;
          details?: Record<string, unknown> | null;
        };
        Relationships: [];
      };
    };
    Views: {};
    Functions: {
      increment_calls_used: {
        Args: { p_tenant_id: string };
        Returns: number;
      };
      reset_monthly_usage: {
        Args: Record<string, never>;
        Returns: void;
      };
    };
    Enums: {};
    CompositeTypes: {};
  };
};

// Convenience type aliases
export type Tenant = Database["public"]["Tables"]["tenants"]["Row"];
export type User = Database["public"]["Tables"]["users"]["Row"];
export type Campaign = Database["public"]["Tables"]["campaigns"]["Row"];
export type Contact = Database["public"]["Tables"]["contacts"]["Row"];
export type CampaignContact = Database["public"]["Tables"]["campaign_contacts"]["Row"];
export type Call = Database["public"]["Tables"]["calls"]["Row"];
export type CallTranscript = Database["public"]["Tables"]["call_transcripts"]["Row"];
export type Template = Database["public"]["Tables"]["templates"]["Row"];
export type AuditLogEntry = Database["public"]["Tables"]["audit_log"]["Row"];
