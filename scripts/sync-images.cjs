/**
 * Syncs Supabase Storage files with image URLs stored in the local SQLite DB.
 *
 * Usage:
 *   node scripts/sync-images.cjs            dry-run (shows what would change)
 *   node scripts/sync-images.cjs --apply    actually update the DB
 *
 * Requires in .env:
 *   SUPABASE_URL=https://<ref>.supabase.co
 *   SUPABASE_BUCKET=postre
 *   SUPABASE_ANON_KEY=eyJhbGci...   (Dashboard -> Settings -> API -> anon public)
 */
const fs = require('fs');
const path = require('path');

// ---- tiny .env loader (project has no dotenv on scripts path) ----
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const BUCKET = process.env.SUPABASE_BUCKET || 'postre';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const APPLY = process.argv.includes('--apply');

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
  console.error('Get the anon key from Supabase Dashboard -> Settings -> API -> "anon public"');
  process.exit(1);
}

const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'postre.db'));

const PUBLIC_BASE = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/`;

// ---------- helpers ----------
/** normalized fingerprint of a filename for fuzzy matching */
function norm(name) {
  return name.toLowerCase()
    .replace(/\.(jpe?g|png|webp|gif)$/, '') // strip ext for compare
    .replace(/[\s_\-.()[\]]+/g, '')          // drop spaces, separators, parens
    .replace(/[^a-z0-9]/g, '');
}

function similarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  // simple dice-coefficient on bigrams
  const bigrams = (s) => {
    const set = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      set.set(g, (set.get(g) || 0) + 1);
    }
    return set;
  };
  const A = bigrams(a), B = bigrams(b);
  let hits = 0;
  for (const [g, n] of A) if (B.has(g)) hits += Math.min(n, B.get(g));
  return (2 * hits) / (Math.max(a.length, 1) + Math.max(b.length, 1) - 2) * 2;
}

/** list all objects in the bucket (paginated, recursive) */
async function listPrefix(prefix, objects) {
  let offset = 0;
  while (true) {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ANON_KEY}`,
        apikey: ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
    });
    if (!res.ok) throw new Error(`list failed: ${res.status} ${await res.text()}`);
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    for (const o of page) {
      if (o.id === null) {
        // folder — recurse into it
        await listPrefix(`${prefix}${o.name}/`, objects);
      } else {
        objects.push(`${prefix}${o.name}`); // full key incl. folder path
      }
    }
    if (page.length < 1000) break;
    offset += 1000;
  }
}

async function listBucket() {
  const objects = [];
  await listPrefix('', objects);
  return objects;
}

async function urlOk(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return res.ok;
  } catch { return false; }
}

// ---------- main ----------
(async () => {
  console.log(`Listing bucket "${BUCKET}"...`);
  const files = await listBucket();
  console.log(`Found ${files.length} files in bucket.\n`);

  const cols = [
    ['categories', 'image'],
    ['products', 'photo_url'],
    ['packages', 'photo_url'],
  ];

  const updates = []; // {table, id, col, oldUrl, newUrl, match}
  for (const [table, col] of cols) {
    let rows;
    try { rows = db.prepare(`SELECT id, ${col} AS url FROM ${table}`).all(); }
    catch { continue; }
    for (const r of rows) {
      const url = r.url;
      if (!url || !/^https?:\/\//.test(url)) continue;
      if (!url.startsWith(PUBLIC_BASE)) continue; // other host (e.g. /uploads) — leave alone
      const key = decodeURIComponent(url.slice(PUBLIC_BASE.length).split('?')[0]);
      if (files.includes(key)) continue; // exact key still exists — fine

      // find best candidate in bucket
      const nKey = norm(key);
      let best = null, bestScore = 0;
      for (const f of files) {
        const s = similarity(nKey, norm(f));
        if (s > bestScore) { bestScore = s; best = f; }
      }
      if (best && bestScore >= 0.6) {
        updates.push({
          table, id: r.id, col, oldUrl: url,
          newUrl: PUBLIC_BASE + best.split('/').map(encodeURIComponent).join('/'),
          match: `${path.basename(best)} (${(bestScore * 100).toFixed(0)}%)`,
        });
      } else {
        updates.push({ table, id: r.id, col, oldUrl: url, newUrl: null, match: best ? `too different: ${path.basename(best)} (${(bestScore * 100).toFixed(0)}%)` : 'no candidate' });
      }
    }
  }

  if (updates.length === 0) {
    console.log('Everything is in sync — no broken Supabase URLs found.');
    return;
  }

  for (const u of updates) {
    const where = `${u.table}#${u.id}`;
    if (u.newUrl) console.log(`FIX  ${where}\n     old: ${u.oldUrl}\n     new: ${u.newUrl}\n     match: ${u.match}\n`);
    else console.log(`NO MATCH ${where}: ${u.oldUrl}\n         (${u.match})\n`);
  }

  const fixable = updates.filter((u) => u.newUrl);
  console.log(`${fixable.length} fixable, ${updates.length - fixable.length} with no confident match.`);

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to write changes to the DB.');
    return;
  }

  const backup = path.join(__dirname, '..', 'data', `postre.db.backup-sync-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.copyFileSync(path.join(__dirname, '..', 'data', 'postre.db'), backup);
  console.log(`Backup saved: ${backup}\n`);

  for (const u of fixable) {
    db.prepare(`UPDATE ${u.table} SET ${u.col} = ? WHERE id = ?`).run(u.newUrl, u.id);
    console.log(`updated ${u.table}#${u.id}`);
  }

  // verify
  console.log('\nVerifying updated URLs...');
  let bad = 0;
  for (const u of fixable) {
    if (!(await urlOk(u.newUrl))) { bad++; console.log(`STILL BROKEN: ${u.newUrl}`); }
  }
  console.log(bad === 0 ? 'All updated URLs verified OK' : `${bad} URLs still broken after sync.`);
})();
