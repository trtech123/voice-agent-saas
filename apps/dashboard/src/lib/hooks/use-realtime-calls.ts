"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import type { Call } from "@vam/database";

export function useRealtimeCalls(tenantId: string | undefined) {
  const [liveCalls, setLiveCalls] = useState<Call[]>([]);

  useEffect(() => {
    if (!tenantId) return;

    const supabase = createClient();

    // Fetch recent calls on mount
    async function fetchRecent() {
      const { data } = await supabase
        .from("calls")
        .select("*")
        .eq("tenant_id", tenantId!)
        .order("created_at", { ascending: false })
        .limit(20);
      if (data) setLiveCalls(data);
    }

    fetchRecent();

    // Subscribe to realtime changes on calls table for this tenant
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
        (payload) => {
          if (payload.eventType === "INSERT") {
            setLiveCalls((prev) => [payload.new as Call, ...prev].slice(0, 50));
          } else if (payload.eventType === "UPDATE") {
            setLiveCalls((prev) =>
              prev.map((c) => (c.id === (payload.new as Call).id ? (payload.new as Call) : c))
            );
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [tenantId]);

  return liveCalls;
}
