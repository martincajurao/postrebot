#!/usr/bin/env node
/**
 * Postre database backup.
 *
 * Dumps every known table from Supabase (via the service-role REST client)
 * into data/backups/backup-<timestamp>/, and copies the local data files
 * (mydb.json, data/*.db*) alongside. Safe to re-run — each run makes its own
 * timestamped folder. Never prints or copies secrets (.env is excluded).
 *
 * Usage:  node scripts/backup-db.mjs        (loads .env via dotenv)
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// All tables the application reads/writes. Missing tables are recorded and skipped.
const TABLES = [
  'admins', 'customers', 'categories', 'products', 'product_variants',
  'packages', 'package_slots', 'package_options', 'carts', 'food_packs',
  'cart_items', 'cart_item_slot_choices', 'orders', 'order_items',
  'order_package_items', 'order_status_history', 'reservations',
  'delivery_areas', 'business_hours', 'blocked_dates', 'time_slots',
  'payments', 'uploads', 'conversation_states', 'push_subscriptions',
  'order_ratings', 'promo_codes', 'app_settings', 'package_orders',
];

function pad(n) { return String(n).padStart(2, '0'); }
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const url = (process.env.SUPABASE_URL || '').trim();
const key = (process.env.SUPABASE_SERVICE_KEY || '').trim();
if (!url || !key) {
  console.error('[backup] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env — cannot reach the live database.');
  process.exit(1);
}

const outDir = path.join(ROOT, 'data', 'backups', `backup-${stamp()}`);
const supabaseDir = path.join(outDir, 'supabase');
fs.mkdirSync(supabaseDir, { recursive: true });

const db = createClient(url, key, { auth: { persistSession: false } });

async function dumpTable(name) {
  const rows = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await db.from(name).select('*').range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  fs.writeFileSync(path.join(supabaseDir, `${name}.json`), JSON.stringify(rows, null, 2), 'utf8');
  return rows.length;
}

// ---- Supabase logical dump (paginated, so >1000-row tables are complete) ----
const summary = [];
let totalRows = 0;
for (const t of TABLES) {
  try {
    const n = await dumpTable(t);
    totalRows += n;
    summary.push(`${t}: ${n}`);
    console.log(`[backup] supabase/${t}.json — ${n} rows`);
  } catch (e) {
    const missing = /does not exist|relation .* not exist|404/i.test(String(e.message || e));
    summary.push(`${t}: ${missing ? 'SKIPPED (table missing)' : 'ERROR: ' + e.message}`);
    console.error(`[backup] ${t}: ${missing ? 'skipped (missing table)' : 'ERROR ' + e.message}, continuing…`);
  }
}

// ---- Local data files (sqlite + legacy json). .env is intentionally EXCLUDED ----
const localCopies = [];
if (fs.existsSync(path.join(ROOT, 'mydb.json'))) {
  fs.copyFileSync(path.join(ROOT, 'mydb.json'), path.join(outDir, 'mydb.json'));
  localCopies.push('mydb.json');
}
const dataDir = path.join(ROOT, 'data');
if (fs.existsSync(dataDir)) {
  for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.db') || entry.name.endsWith('.db-wal') || entry.name.endsWith('.db-shm')) {
      fs.copyFileSync(path.join(dataDir, entry.name), path.join(outDir, entry.name));
      localCopies.push(`data/${entry.name}`);
    }
  }
}

const manifest = {
  created_at: new Date().toISOString(),
  source: 'Supabase REST (service role) + local files',
  tables: summary,
  total_rows: totalRows,
  local_files: localCopies,
};
fs.writeFileSync(path.join(outDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf8');

console.log('\n[backup] DONE');
console.log(`[backup] Folder : ${outDir}`);
console.log(`[backup] Tables : ${TABLES.length} processed, ${totalRows.toLocaleString()} total rows`);
console.log(`[backup] Local  : ${localCopies.join(', ') || '(none — no sqlite/json data files found)'}`);