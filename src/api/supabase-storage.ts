import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * All image CRUD (create/read/update/delete) goes through Supabase Storage.
 * The SQLite `uplasdoads` asdxx table only keeps lightweight metadata (name, mime,
 * public URL) so the admin panel can list files — the bytes themselves live
 * in the bucket.
 */
// Read env lazily (not at module import time) so runtime env vars are always
// seen, regardless of import order or when the process got its environment.
const env = () => ({
  url: (process.env.SUPABASE_URL || '').trim(),
  key: (process.env.SUPABASE_SERVICE_KEY || '').trim(),
  bucket: (process.env.SUPABASE_BUCKET || 'postre').trim(),
});

let client: SupabaseClient | null = null;

export function supa(): SupabaseClient {
  const { url, key, bucket: b } = env();
  if (!client) {
    if (!url || !key) {
      const missing = [!url && 'SUPABASE_URL', !key && 'SUPABASE_SERVICE_KEY'].filter(Boolean).join(', ');
      throw new Error(`Supabase not configured — missing env var(s): ${missing}`);
    }
    client = createClient(url, key, {
      auth: { persistSession: false },
    });
  }
  return client;
}

export function configured(): boolean {
  const { url, key } = env();
  return Boolean(url && key);
}

export function bucket(): string {
  return env().bucket;
}

/** Upload bytes → returns the public URL of the object. */
export async function uploadImage(name: string, mime: string, bytes: Buffer): Promise<string> {
  const B = bucket();
  const { error } = await supa().storage.from(B).upload(name, bytes, {
    contentType: mime,
    upsert: true,
  });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
  return publicUrl(name);
}

/** Public URL for an object in the bucket. */
export function publicUrl(name: string): string {
  return supa().storage.from(bucket()).getPublicUrl(name).data.publicUrl;
}

/** List all image objects in the bucket (any folder depth). */
export async function listImages(): Promise<{ name: string; url: string; updated_at?: string }[]> {
  const B = bucket();
  const out: { name: string; url: string; updated_at?: string }[] = [];
  const walk = async (prefix: string) => {
    const { data, error } = await supa().storage.from(B).list(prefix, {
      limit: 1000,
      sortBy: { column: 'created_at', order: 'desc' },
    });
    if (error) throw new Error(`Supabase list failed: ${error.message}`);
    for (const item of data || []) {
      const full = prefix ? `${prefix}/${item.name}` : item.name;
      if ((item as any).id === null) {
        await walk(full); // folder
      } else {
        out.push({ name: full, url: publicUrl(full), updated_at: (item as any).updated_at });
      }
    }
  };
  await walk('');
  return out;
}

/** Delete one or many objects. */
export async function deleteImages(names: string[]): Promise<void> {
  const { error } = await supa().storage.from(bucket()).remove(names);
  if (error) throw new Error(`Supabase delete failed: ${error.message}`);
}

/** Download an object's bytes (used by the migration script). */
export async function downloadImage(name: string): Promise<Buffer> {
  const { data, error } = await supa().storage.from(bucket()).download(name);
  if (error) throw new Error(`Supabase download failed: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

/** Startup diagnostic — log which Supabase env vars the process actually sees. */
export function logConfig(): void {
  const { url, key, bucket: b } = env();
  console.log(`[supabase] URL: ${url ? url : 'MISSING'} | SERVICE_KEY: ${key ? `set (${key.slice(0, 9)}…, ${key.length} chars)` : 'MISSING'} | BUCKET: ${b}`);
}
