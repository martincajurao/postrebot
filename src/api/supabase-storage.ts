import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * All image CRUD (create/read/update/delete) goes through Supabase Storage.
 * The SQLite `uploads` table only keeps lightweight metadata (name, mime,
 * public URL) so the admin panel can list files — the bytes themselves live
 * in the bucket.
 */
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
const BUCKET = process.env.SUPABASE_BUCKET || 'postre';

let client: SupabaseClient | null = null;

export function supa(): SupabaseClient {
  if (!client) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_ANON_KEY) must be set in .env');
    }
    client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    });
  }
  return client;
}

export function configured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
}

export const bucket = BUCKET;

/** Upload bytes → returns the public URL of the object. */
export async function uploadImage(name: string, mime: string, bytes: Buffer): Promise<string> {
  const { error } = await supa().storage.from(BUCKET).upload(name, bytes, {
    contentType: mime,
    upsert: true,
  });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
  return publicUrl(name);
}

/** Public URL for an object in the bucket. */
export function publicUrl(name: string): string {
  return supa().storage.from(BUCKET).getPublicUrl(name).data.publicUrl;
}

/** List all image objects in the bucket (any folder depth). */
export async function listImages(): Promise<{ name: string; url: string; updated_at?: string }[]> {
  const out: { name: string; url: string; updated_at?: string }[] = [];
  const walk = async (prefix: string) => {
    const { data, error } = await supa().storage.from(BUCKET).list(prefix, {
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
  const { error } = await supa().storage.from(BUCKET).remove(names);
  if (error) throw new Error(`Supabase delete failed: ${error.message}`);
}

/** Download an object's bytes (used by the migration script). */
export async function downloadImage(name: string): Promise<Buffer> {
  const { data, error } = await supa().storage.from(BUCKET).download(name);
  if (error) throw new Error(`Supabase download failed: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}
