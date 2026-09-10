/**
 * One-time migration: copy branch availability from the legacy mydb.json into
 * Supabase products/packages, and set app_settings branches + GPS centers.
 *
 *   node scripts/migrate-branches.mjs
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_KEY (reads .env). Idempotent —
 * re-running just re-applies the same values.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const url = (process.env.SUPABASE_URL || '').trim();
const key = (process.env.SUPABASE_SERVICE_KEY || '').trim();
if (!url || !key) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
const db = createClient(url, key, { auth: { persistSession: false } });

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const LEGACY_TO_KEY = { naga: 'naga', calbayog: 'calbayog', samar: 'calbayog' };
const mapLegacy = (list) =>
  (Array.isArray(list) ? list : [])
    .map((b) => LEGACY_TO_KEY[String(b || '').trim().toLowerCase()])
    .filter(Boolean);

// ---- 1. Load legacy assignments ----
const legacy = JSON.parse(readFileSync(new URL('../mydb.json', import.meta.url), 'utf8'));

// Menu: uuid → { name, branches }
const menuByUuid = new Map();
const menuByName = new Map();
for (const v of Object.values(legacy.Menu || {})) {
  const name = v?.menuName || v?.name;
  const branches = mapLegacy(v?.branches);
  if (name && branches.length) {
    menuByUuid.set(String(v?.menuCode || ''), branches);
    menuByName.set(norm(name), branches);
  }
}

// Combo: name → branches (packages). Combo members' item-level branches are
// already covered by the Menu entries they reference.
const comboByName = new Map();
for (const v of Object.values(legacy.Combo || {})) {
  const name = v?.name;
  const branches = mapLegacy(v?.branches);
  if (name && branches.length) comboByName.set(norm(name), branches);
}

// ---- 2. Apply to products ----
const { data: products, error: pe } = await db.from('products').select('id, name, branches');
if (pe) { console.error('products fetch failed:', pe.message); process.exit(1); }
let pHit = 0, pMiss = [];
for (const p of products || []) {
  const branches = menuByName.get(norm(p.name)) || menuByUuid.get(norm(p.name));
  if (!branches) { pMiss.push(p.name); continue; }
  const { error } = await db.from('products').update({ branches: JSON.stringify(branches) }).eq('id', p.id);
  if (error) console.error(`  ✗ product ${p.name}: ${error.message}`);
  else { pHit++; console.log(`  ✓ ${p.name} → [${branches.join(', ')}]`); }
}

// ---- 3. Apply to packages ----
const { data: packages, error: ke } = await db.from('packages').select('id, name, branches');
if (ke) { console.error('packages fetch failed:', ke.message); process.exit(1); }
let kHit = 0; const kMiss = [];
for (const k of packages || []) {
  const branches = comboByName.get(norm(k.name));
  if (!branches) { kMiss.push(k.name); continue; }
  const { error } = await db.from('packages').update({ branches: JSON.stringify(branches) }).eq('id', k.id);
  if (error) console.error(`  ✗ package ${k.name}: ${error.message}`);
  else { kHit++; console.log(`  ✓ package ${k.name} → [${branches.join(', ')}]`); }
}

// ---- 4. app_settings: branch list + GPS centers ----
const now = new Date().toISOString();
const upsert = async (k, value) => {
  const { data: ex } = await db.from('app_settings').select('key').eq('key', k).maybeSingle();
  if (ex) await db.from('app_settings').update({ value, updated_at: now }).eq('key', k);
  else await db.from('app_settings').insert({ key: k, value, updated_at: now });
};
await upsert('branches', JSON.stringify(['naga', 'calbayog']));
await upsert('branch_coords', JSON.stringify({
  naga: { lat: 13.6218, lng: 123.1948 },
  calbayog: { lat: 12.067, lng: 124.583 },
}));
console.log('app_settings: branches=[naga, calbayog], coords set');

console.log(`\nDone. products updated: ${pHit} (unmatched: ${pMiss.length}), packages updated: ${kHit} (unmatched: ${kMiss.length})`);
if (pMiss.length) console.log('Products without legacy branch data (left as all-branches):', pMiss.join(', '));
if (kMiss.length) console.log('Packages without legacy branch data:', kMiss.join(', '));
