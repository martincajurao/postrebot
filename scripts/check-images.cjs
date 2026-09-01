/** Scans the DB for image URLs and checks which Supabase ones still exist. */
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/postre.db');

const cols = [
  ['categories', 'image'],
  ['products', 'photo_url'],
  ['packages', 'photo_url'],
];

(async () => {
  const urls = new Map(); // url -> [where]
  for (const [table, col] of cols) {
    let rows;
    try { rows = db.prepare(`SELECT id, ${col} AS url FROM ${table}`).all(); }
    catch { continue; }
    for (const r of rows) {
      if (r.url && /^https?:\/\//.test(r.url)) {
        if (!urls.has(r.url)) urls.set(r.url, []);
        urls.get(r.url).push(`${table}#${r.id}`);
      }
    }
  }
  console.log(`Checking ${urls.size} remote image URLs...\n`);
  let broken = 0;
  for (const [url, where] of urls) {
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      if (!res.ok) { broken++; console.log(`BROKEN ${res.status}  ${url}\n   used by: ${where.join(', ')}`); }
      else console.log(`ok        ${url}`);
    } catch (e) { broken++; console.log(`ERROR ${e.message}  ${url}\n   used by: ${where.join(', ')}`); }
  }
  console.log(`\n${broken} broken of ${urls.size}`);
})();
