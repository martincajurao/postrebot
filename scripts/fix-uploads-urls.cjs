/**
 * Fixes image URLs stored in the SQLite DB:
 *   - Absolute http(s) URLs that point at /uploads/... are rewritten to the
 *     relative path ("/uploads/<file>"). The file is served by this same
 *     server, so the stored link stays valid even if the domain changes
 *     (e.g. from a temporary ngrok tunnel to the live Render URL). The public
 *     origin is added automatically when the image is sent to Messenger.
 *
 * Usage:
 *   node scripts/fix-uploads-urls.cjs            dry-run (shows what would change)
 *   node scripts/fix-uploads-urls.cjs --apply    actually update the DB
 */
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const DB_PATH = path.join(__dirname, '..', 'data', 'postre.db');

const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(DB_PATH);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
const changes = [];

for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  for (const col of cols) {
    if (!/url|img|image|photo/i.test(col)) continue;
    let rows;
    try { rows = db.prepare(`SELECT rowid AS rid, ${col} AS v FROM ${t}`).all(); }
    catch { continue; }
    for (const row of rows) {
      const v = row.v;
      if (typeof v !== 'string' || !/^https?:\/\//i.test(v)) continue;
      const m = v.match(/^https?:\/\/[^/]+(\/uploads\/[^?#]+)/i);
      if (!m) continue;
      changes.push({ table: t, rid: row.rid, col, old: v, neu: m[1] });
    }
  }
}

if (changes.length === 0) {
  console.log('No absolute /uploads/... URLs found — nothing to fix.');
  process.exit(0);
}

for (const c of changes) {
  console.log(`FIX ${c.table}#${c.rid}.${c.col}\n     old: ${c.old}\n     new: ${c.neu}`);
}

if (!APPLY) {
  console.log(`\nDry run only — ${changes.length} URL(s) would change. Re-run with --apply.`);
  process.exit(0);
}

const backup = path.join(__dirname, '..', 'data', `postre.db.backup-fixurls-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.copyFileSync(DB_PATH, backup);
console.log(`\nBackup saved: ${backup}\n`);

for (const c of changes) {
  db.prepare(`UPDATE ${c.table} SET ${c.col} = ? WHERE rowid = ?`).run(c.neu, c.rid);
  console.log(`updated ${c.table}#${c.rid}.${c.col}`);
}

// The main .db file is what gets committed/deployed — fold the WAL into it.
db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
db.close();
console.log('\nDone. WAL checkpointed into data/postre.db.');
