// packages/database/src/client.ts
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types.js";

/**
 * Create a Supabase client for browser/server use (respects RLS via auth JWT).
 */
export function createSupabaseClient(
  url: string,
  anonKey: string
): SupabaseClient<Database> {
  return createClient<Database>(url, anonKey);
}

/**
 * Create a Supabase admin client for the voice engine (service role, bypasses RLS).
 * ONLY use through the tenant-scoped DAL — never directly.
 */
export function createSupabaseAdmin(
  url: string,
  serviceRoleKey: string
): SupabaseClient<Database> {
  return createClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
