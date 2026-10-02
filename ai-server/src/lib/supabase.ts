import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

const g = globalThis as { __aitermSupabase?: SupabaseClient };

// Server-only client using the secret key. It bypasses RLS, so it must never
// be imported into a client component.
export function db(): SupabaseClient {
  if (!g.__aitermSupabase) {
    const { SUPABASE_URL, SUPABASE_SECRET_KEY } = env();
    g.__aitermSupabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return g.__aitermSupabase;
}

export function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}
