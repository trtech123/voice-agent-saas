"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import type { User as AppUser } from "@vam/database";
import type { User as AuthUser } from "@supabase/supabase-js";

export function useUser() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [appUser, setAppUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();

    async function fetchUser() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setLoading(false);
        return;
      }
      setAuthUser(user);

      const { data } = await supabase
        .from("users")
        .select("*")
        .eq("id", user.id)
        .single();

      setAppUser(data);
      setLoading(false);
    }

    fetchUser();
  }, []);

  return { authUser, appUser, loading };
}
