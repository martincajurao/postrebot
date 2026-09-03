/** One-off: strip dead Supabase Storage URLs from the local DB. */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'postre.db'));
let changed = 0;
for (const [t, c] of [['products', 'photo_url'], ['packages', 'photo_url'], ['categories', 'image']]) {
  try {
    const r = db.prepare(`UPDATE ${t} SET ${c} = NULL WHERE ${c} LIKE '%supabase.co%'`).run();
    changed += r.changes;
  } catch { /* column may not exist */ }
}
console.log(`Cleared ${changed} dead Supabase URL(s).`);
