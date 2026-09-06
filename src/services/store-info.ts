import { supa } from '../db/supabase';

/**
 * Store info (payment + contact details shown to customers).
 * Single source of truth for the Messenger bot and the web ordering page:
 *  - Admin → Settings → 💳 Payment and Contact stores overrides in app_settings
 *  - the PAYMENT_* and CONTACT_* env vars remain the defaults
 * Cached in-process for 60s (invalidateStoreInfoCache() runs on admin save).
 */
export const STORE_INFO_KEYS = [
  'payment_gcash', 'payment_bank', 'contact_phone', 'contact_email', 'contact_address', 'contact_hours',
] as const;
export type StoreInfoKey = typeof STORE_INFO_KEYS[number];

export interface StoreInfo {
  payment_gcash: string;
  payment_bank: string;
  contact_phone: string;
  contact_email: string;
  contact_address: string;
  contact_hours: string;
}

export function storeInfoDefaults(): StoreInfo {
  return {
    payment_gcash: process.env.PAYMENT_GCASH || 'GCash: 09753122085 (M*rt*n N*ko C.). Send the receipt to confirm.',
    payment_bank: process.env.PAYMENT_BANK || 'BDO: 0000-0000-0000 (Not Available). Send the receipt to confirm.',
    contact_phone: process.env.CONTACT_PHONE || '0917-000-0000',
    contact_email: process.env.CONTACT_EMAIL || 'hello@postre.example',
    contact_address: process.env.CONTACT_ADDRESS || '123 Sample St.',
    contact_hours: process.env.CONTACT_HOURS || 'Mon-Sat, 10AM-7PM',
  };
}

let cache: { at: number; overrides: Partial<Record<StoreInfoKey, string>> } | null = null;
const CACHE_TTL = 60_000;

export function invalidateStoreInfoCache(): void {
  cache = null;
}

/** Admin overrides (app_settings) merged over the env defaults. */
export async function getStoreInfo(): Promise<StoreInfo> {
  if (!cache || Date.now() - cache.at > CACHE_TTL) {
    const overrides: Partial<Record<StoreInfoKey, string>> = {};
    try {
      const { data, error } = await supa().from('app_settings').select('key, value').in('key', STORE_INFO_KEYS as unknown as string[]);
      if (error) throw error;
      for (const row of data || []) {
        if ((STORE_INFO_KEYS as readonly string[]).includes(row.key)) {
          overrides[row.key as StoreInfoKey] = String(row.value ?? '').trim();
        }
      }
      cache = { at: Date.now(), overrides };
    } catch (e: any) {
      console.warn('[store-info] read failed — using env defaults:', e?.message || e);
      cache = { at: Date.now(), overrides: cache?.overrides ?? {} };
    }
  }
  const d = storeInfoDefaults();
  const o = cache.overrides;
  return {
    payment_gcash: o.payment_gcash || d.payment_gcash,
    payment_bank: o.payment_bank || d.payment_bank,
    contact_phone: o.contact_phone || d.contact_phone,
    contact_email: o.contact_email || d.contact_email,
    contact_address: o.contact_address || d.contact_address,
    contact_hours: o.contact_hours || d.contact_hours,
  };
}
