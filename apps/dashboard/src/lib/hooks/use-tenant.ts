"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import type { Tenant } from "@vam/database";

export function useTenant() {
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();

    async function fetchTenant() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setLoading(false);
        return;
      }

      const tenantId = user.app_metadata?.tenant_id;
      if (!tenantId) {
        setLoading(false);
        return;
      }

      const { data } = await supabase
        .from("tenants")
        .select("*")
        .eq("id", tenantId)
        .single();

      setTenant(data);
      setLoading(false);
    }

    fetchTenant();
  }, []);

  return { tenant, loading };
}
