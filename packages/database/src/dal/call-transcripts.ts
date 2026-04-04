// packages/database/src/dal/call-transcripts.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, CallTranscript } from "../types.js";

export class CallTranscriptDAL {
  constructor(
    private db: SupabaseClient<Database>,
    private tenantId: string
  ) {}

  async save(callId: string, transcript: CallTranscript["transcript"]): Promise<CallTranscript> {
    const { data, error } = await this.db
      .from("call_transcripts")
      .upsert(
        { call_id: callId, tenant_id: this.tenantId, transcript },
        { onConflict: "call_id" }
      )
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async getByCallId(callId: string): Promise<CallTranscript | null> {
    const { data, error } = await this.db
      .from("call_transcripts")
      .select("*")
      .eq("call_id", callId)
      .eq("tenant_id", this.tenantId)
      .single();
    if (error && error.code !== "PGRST116") throw error;
    return data;
  }
}
