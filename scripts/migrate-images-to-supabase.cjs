/**
 * One-time migration: push every existing image (disk + SQLite bytes) to
 * Supabase Storage and rewrite product/package photo URLs to public URLs.
 *
 * Usage: node dist/scripts/migrate-images-to-supabase.cjs
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

require('dotenv').config();

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'postre';
if (!URL_ || !KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_ANON_KEY) required');
  process.exit(1);
}
const supa = createClient(URL_, KEY, { auth: { persistSession: false } });

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const db = new DatabaseSync(process.env.DATABASE_FILE || './data/postre.db');
db.exec("CREATE TABLE IF NOT EXISTS uploads (name TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL, created_at TEXT DEFAULT (datetime('now')))");
const upCols = db.prepare('PRAGMA table_info(uploads)').all().map((c) => c.name);
if (!upCols.includes('public_url')) db.exec('ALTER TABLE uploads ADD COLUMN public_url TEXT;');

(async () => {
  const toUpload = new Map(); // name -> Buffer
  // SQLite bytes
  for (const row of db.prepare('SELECT name, bytes FROM uploads').all()) {
    const buf = Buffer.from(row.bytes || []);
    if (buf.length) toUpload.set(row.name, buf);
  }
  // disk files
  for (const dir of ['./data/uploads', './dist/data/uploads']) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!MIME[path.extname(f).toLowerCase()] || toUpload.has(f)) continue;
      toUpload.set(f, fs.readFileSync(path.join(dir, f)));
    }
  }
  console.log(`Uploading ${toUpload.size} images to bucket "${BUCKET}"...`);
  for (const [name, bytes] of toUpload) {
    const { error } = await supa.storage.from(BUCKET).upload(name, bytes, {
      contentType: MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
      upsert: true,
    });
    if (error) console.error(`  FAIL ${name}: ${error.message}`);
    else {
      const url = supa.storage.from(BUCKET).getPublicUrl(name).data.publicUrl;
      db.prepare('INSERT OR REPLACE INTO uploads (name, mime, bytes, public_url) VALUES (?, ?, ?, ?)')
        .run(name, MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', Buffer.alloc(0), url);
      console.log(`  ok ${name} -> ${url}`);
    }
  }
  // Rewrite product/package URLs pointing at local /uploads/ paths
  const all = db.prepare('SELECT name, public_url FROM uploads WHERE public_url IS NOT NULL').all();
  for (const [table, col] of [['products', 'photo_url'], ['packages', 'photo_url']]) {
    for (const { name, public_url } of all) {
      db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} LIKE ? OR ${col} LIKE ?`)
        .run(public_url, `%/uploads/${name}`, `%/${name}`);
    }
  }
  console.log('Migration complete.');
  process.exit(0);
})();
