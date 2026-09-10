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
  naga: { lat: 13.6218, lng: 123.1948 },   // Naga City, Camarines Sur
  calbayog: { lat: 12.067, lng: 124.583 }, // Calbayog City, Samar
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