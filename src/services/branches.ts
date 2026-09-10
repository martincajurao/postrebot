/**
 * Branching (location) availability helpers.
 *
 * Which branches a product or package is available at is stored on the row as a
 * JSON-encoded array of branch keys, e.g. '["naga","samar"]'. NULL / empty
 * means "available at every branch". The catalog of branch keys itself lives
 * in app_settings['branches'] and defaults to ['naga','samar'] (editable in
 * Admin → Settings → Branches / Locations).
 */
import { supa } from '../db/supabase';

export const DEFAULT_BRANCHES: string[] = ['naga', 'calbayog'];

/** Normalize any stored shape (array, JSON string, comma list, empty) into branch keys. */
export function parseBranches(v: any): string[] {
  const norm = (b: any) => String(b).trim().toLowerCase();
  if (Array.isArray(v)) {
    return v.map(norm).filter(Boolean);
  }
  if (typeof v !== 'string' || !v.trim()) return [];
  const t = v.trim();
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr)) return arr.map(norm).filter(Boolean);
    } catch { /* not JSON — fall through and split by comma */ }
  }
  return t.split(',').map(norm).filter(Boolean);
}

/** Serialize a branch list for storage. null (empty list) = available everywhere. */
export function serializeBranches(v: any): string | null {
  const arr = parseBranches(v);
  return arr.length ? JSON.stringify(arr) : null;
}

const BRANCHES_KEY = 'branches';

/** The active branch list — app_settings override, else the defaults. */
export async function getBranches(): Promise<string[]> {
  try {
    const { data } = await supa().from('app_settings').select('value').eq('key', BRANCHES_KEY).maybeSingle();
    const parsed = data?.value ? parseBranches(data.value) : [];
    return parsed.length ? parsed : [...DEFAULT_BRANCHES];
  } catch {
    return [...DEFAULT_BRANCHES];
  }
}

/** Persist the branch list. Empty input falls back to the defaults. */
export async function saveBranches(v: any): Promise<string[]> {
  const saved = parseBranches(v);
  const value = JSON.stringify(saved.length ? saved : DEFAULT_BRANCHES);
  const now = new Date().toISOString();
  const { data: existing } = await supa().from('app_settings').select('key').eq('key', BRANCHES_KEY).maybeSingle();
  if (existing) {
    await supa().from('app_settings').update({ value, updated_at: now }).eq('key', BRANCHES_KEY);
  } else {
    await supa().from('app_settings').insert({ key: BRANCHES_KEY, value, updated_at: now });
  }
  return parseBranches(value);
}

/** True when an item (with a stored branches field) is available at `branch`. */
export function availableAtBranch(item: any, branch?: string): boolean {
  if (!branch) return true; // no branch selected → everything
  const list = parseBranches(item?.branches);
  if (list.length === 0) return true; // empty / NULL = all branches
  return list.includes(String(branch).trim().toLowerCase());
}

// ---------- Branch GPS centers (used by the webview to detect the customer's
// branch from their GPS position) ----------
// Each branch key can have a center point. Admin can override the defaults via
// app_settings['branch_coords'] (JSON map: { "naga": {lat, lng}, ... }).
export interface BranchCatalogEntry { key: string; name: string; lat: number | null; lng: number | null; }

export const DEFAULT_BRANCH_COORDS: Record<string, { lat: number; lng: number }> = {
  naga: { lat: 13.660509, lng: 123.176748 },   // Store — Naga
  calbayog: { lat: 12.072692, lng: 124.610228 }, // Store — Calbayog (Samar)
};
const COORDS_KEY = 'branch_coords';

/** Branch centers for the current branch list — code defaults merged with the
 *  optional admin override stored in app_settings['branch_coords']. */
export async function getBranchCoords(): Promise<Record<string, { lat: number; lng: number }>> {
  const out: Record<string, { lat: number; lng: number }> = {};
  for (const k of await getBranches()) {
    const d = DEFAULT_BRANCH_COORDS[k];
    if (d) out[k] = { ...d };
  }
  try {
    const { data } = await supa().from('app_settings').select('value').eq('key', COORDS_KEY).maybeSingle();
    const parsed = data?.value ? JSON.parse(data.value) : null;
    if (parsed && typeof parsed === 'object') {
      for (const [k, c] of Object.entries(parsed as Record<string, any>)) {
        const lat = Number((c as any)?.lat), lng = Number((c as any)?.lng);
        if (Number.isFinite(lat) && Number.isFinite(lng)) out[k] = { lat, lng };
      }
    }
  } catch { /* defaults remain */ }
  return out;
}

/** Persist branch GPS centers (only valid finite numbers are kept). */
export async function saveBranchCoords(coords: Record<string, { lat: number; lng: number }>): Promise<void> {
  const clean: Record<string, { lat: number; lng: number }> = {};
  for (const [k, c] of Object.entries(coords || {})) {
    const lat = Number((c as any)?.lat), lng = Number((c as any)?.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) clean[k] = { lat, lng };
  }
  const value = JSON.stringify(clean);
  const now = new Date().toISOString();
  const { data: existing } = await supa().from('app_settings').select('key').eq('key', COORDS_KEY).maybeSingle();
  if (existing) {
    await supa().from('app_settings').update({ value, updated_at: now }).eq('key', COORDS_KEY);
  } else {
    await supa().from('app_settings').insert({ key: COORDS_KEY, value, updated_at: now });
  }
}

/** Branch list with GPS centers — what the webview uses to pick the branch
 *  from the customer's location. */
export async function getBranchCatalog(): Promise<BranchCatalogEntry[]> {
  const [keys, coords] = await Promise.all([getBranches(), getBranchCoords()]);
  return keys.map((k) => {
    const c = coords[k];
    return {
      key: k,
      name: k.charAt(0).toUpperCase() + k.slice(1),
      lat: c ? c.lat : null,
      lng: c ? c.lng : null,
    };
  });
}

/** Nearest branch to a lat/lng point (planar projection — plenty accurate at
 *  these latitudes). Returns null when no branch has coordinates. */
export function nearestBranchKey(lat: number, lng: number, catalog: BranchCatalogEntry[]): string | null {
  const usable = (catalog || []).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng) && Number.isFinite(lat) && Number.isFinite(lng));
  if (usable.length === 0) return null;
  const cosLat = Math.cos((lat + usable[0].lat!) / 2 * Math.PI / 180);
  let bestKey: string | null = null;
  let best = Infinity;
  for (const c of usable) {
    const dx = (lng - c.lng!) * cosLat;
    const dy = lat - c.lat!;
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; bestKey = c.key; }
  }
  return bestKey;
}

// ---------- Delivery fee engine ----------
// ₱50 base + ₱1 per 100 m from the store (branch origin) to the customer's pin.
export const DELIVERY_BASE_FEE = 50;
export const DELIVERY_FEE_PER_100M = 1;

/** Great-circle distance between two points in meters. */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Distance-based delivery fee: ₱50 base + ₱1 per 100 m (each partial 100 m rounds up). */
export function computeDeliveryFee(fromLat: number, fromLng: number, toLat: number, toLng: number): {
  fee: number; distanceMeters: number; distanceKm: number;
} {
  const distanceMeters = haversineMeters(fromLat, fromLng, toLat, toLng);
  const fee = DELIVERY_BASE_FEE + Math.ceil(distanceMeters / 100) * DELIVERY_FEE_PER_100M;
  return { fee, distanceMeters: Math.round(distanceMeters), distanceKm: Math.round(distanceMeters / 100) / 10 };
}

/** Waze deep link so the rider can one-tap navigate to the drop-off pin. */
export function buildWazeUrl(lat: number, lng: number): string {
  return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
}

/** Waze APP deep link (custom scheme). Custom-scheme links are NOT intercepted
 *  by in-app webviews (Messenger etc.) the way https universal links are —
 *  they always hand off to the Waze app directly. Dead link if Waze isn't
 *  installed, which is why every place that shows it also shows the https
 *  fallback from buildWazeUrl(). */
export function buildWazeAppUrl(lat: number, lng: number): string {
  return `waze://?ll=${lat},${lng}&navigate=yes`;
}