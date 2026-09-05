/**
 * Server-side Supabase client — replaces raw SQL with Supabase query builder.
 * All database operations go through here so no SQL strings appear in the codebase.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function supa(): SupabaseClient {
  if (!client) {
    const url = (process.env.SUPABASE_URL || '').trim();
    const key = (process.env.SUPABASE_SERVICE_KEY || '').trim();
    if (!url || !key) throw new Error('Supabase not configured — missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}
