"use client";

import { useEffect, useState } from "react";
import {
  buildCallSummary,
  getCallStatusLabel,
  getCallTimestamp,
  getDashboardContact,
  getOutcomeFromCall,
  isLiveCall,
  type DashboardContact,
  type DashboardConversation,
} from "@/lib/dashboard";
import { createClient } from "@/lib/supabase-browser";
import type { Call, Contact } from "@vam/database";

type CallWithContact = Call & {
  contacts: Pick<Contact, "id" | "name" | "phone"> | Array<Pick<Contact, "id" | "name" | "phone">> | null;
};

export function useRealtimeCalls(tenantId: string | undefined) {
  const [recentCalls, setRecentCalls] = useState<DashboardConversation[]>([]);

  useEffect(() => {
    if (!tenantId) return;

    const supabase = createClient();

    function normalizeContact(
      contact: CallWithContact["contacts"]
    ): DashboardContact | null {
      if (Array.isArray(contact)) {
        return getDashboardContact(contact[0]);
      }

      return getDashboardContact(contact);
    }

    function toConversation(call: CallWithContact): DashboardConversation | null {
      const contact = normalizeContact(call.contacts);
      if (!contact) return null;

      const outcome = getOutcomeFromCall(call);

      return {
        conversationId: call.id,
        leadId: call.contact_id,
        campaignId: call.campaign_id,
        contact,
        status: call.status,
        statusLabel: getCallStatusLabel(call.status),
        outcomeLabel: outcome.label,
        outcomeStatus: outcome.status,
        summary: buildCallSummary(call),
        timestamp: getCallTimestamp(call),
        startedAt: call.started_at,
        endedAt: call.ended_at,
        durationSeconds: call.duration_seconds,
        leadScore: call.lead_score,
        isLive: isLiveCall(call.status),
      };
    }

    async function fetchRecent() {
      const { data } = await supabase
        .from("calls")
        .select("*, contacts(id, name, phone)")
        .eq("tenant_id", tenantId as string)
        .order("started_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(20);

      if (!data) {
        setRecentCalls([]);
        return;
      }

      setRecentCalls(
        data
          .map((row) => toConversation(row as CallWithContact))
          .filter((row): row is DashboardConversation => row !== null)
      );
    }

    void fetchRecent();

    const channel = supabase
      .channel("calls-realtime")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "calls",
          filter: `tenant_id=eq.${tenantId}`,
        },
        () => {
          void fetchRecent();
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [tenantId]);

  return recentCalls;
}
