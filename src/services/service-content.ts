import { supa } from '../db/supabase';

/** Service content (catering messages, etc.) shown to customers.
 *  Single source of truth for the Messenger bot:
 *   - Admin → Services tab stores content in app_settings
 *  Cached in-process for 60s (invalidateServiceCache() runs on admin save).
 */
export const SERVICE_CONTENT_KEYS = [
  'catering_intro_text',
  'catering_packages_text',
  'catering_custom_text',
  'catering_quote_text',
] as const;
export type ServiceContentKey = typeof SERVICE_CONTENT_KEYS[number];

export interface ServiceContent {
  catering_intro_text: string;
  catering_packages_text: string;
  catering_custom_text: string;
  catering_quote_text: string;
}

export function serviceContentDefaults(): ServiceContent {
  return {
    catering_intro_text: `🧁 CATERING SERVICES

We offer catering for events, parties, and special occasions!

✔️ Customizable food packages
✔️ Delivery or pickup available
✔️ Bulk orders welcome

Interested in our catering packages? Reply with:
• "packages" - to see available packages
• "custom" - to request a custom catering order
• "quote" - for a price estimate`,
    catering_packages_text: `📦 CATERING PACKAGES

Choose from our pre-configured packages for your event:

• Small Package (10-20 pax) - Perfect for small gatherings
• Medium Package (21-50 pax) - Great for parties
• Large Package (51+ pax) - Ideal for big events

Each package can be customized with your preferred menu items.

Reply with the package size you're interested in!`,
    catering_custom_text: `🎯 CUSTOM CATERING ORDER

We'll create a custom menu for your event!

Please provide:
1. Event type (wedding, birthday, corporate, etc.)
2. Number of guests
3. Preferred date
4. Budget range
5. Any dietary restrictions

We'll prepare a personalized quote based on your requirements.`,
    catering_quote_text: `💰 CATERING QUOTE

To provide an accurate estimate, please share:

• Event date
• Number of guests
• Preferred menu/style
• Pickup or delivery
• Any special requests

Our team will prepare a detailed quote within 24 hours.`,
  };
}

let cache: { at: number; overrides: Partial<Record<ServiceContentKey, string>> } | null = null;
const CACHE_TTL = 60_000;

export function invalidateServiceCache(): void {
  cache = null;
}

/** Admin overrides (app_settings) merged over the defaults. */
export async function getServiceContent(): Promise<ServiceContent> {
  if (!cache || Date.now() - cache.at > CACHE_TTL) {
    const overrides: Partial<Record<ServiceContentKey, string>> = {};
    try {
      const { data, error } = await supa().from('app_settings').select('key, value').in('key', SERVICE_CONTENT_KEYS as unknown as string[]);
      if (error) throw error;
      for (const row of data || []) {
        if ((SERVICE_CONTENT_KEYS as readonly string[]).includes(row.key)) {
          overrides[row.key as ServiceContentKey] = String(row.value ?? '').trim();
        }
      }
      cache = { at: Date.now(), overrides };
    } catch (e: any) {
      console.warn('[service-content] read failed — using defaults:', e?.message || e);
      cache = { at: Date.now(), overrides: cache?.overrides ?? {} };
    }
  }
  const d = serviceContentDefaults();
  const o = cache.overrides;
  return {
    catering_intro_text: o.catering_intro_text || d.catering_intro_text,
    catering_packages_text: o.catering_packages_text || d.catering_packages_text,
    catering_custom_text: o.catering_custom_text || d.catering_custom_text,
    catering_quote_text: o.catering_quote_text || d.catering_quote_text,
  };
}
