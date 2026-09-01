/**
 * E2E check for Messenger image display (runs against a COPY of the real DB,
 * Messenger sends mocked — nothing is actually sent to Facebook).
 *
 * Verifies, with NO BASE_URL configured (as on Render):
 *   1. a relative /uploads/... image becomes an absolute https URL derived
 *      from the webhook request origin (x-forwarded-proto + Host)
 *   2. live remote (Supabase) images keep their cache-buster and stay in the
 *      carousel payload
 *   3. dead remote images are dropped by pre-flight without breaking the send
 *   4. filenames with special characters (e.g. "sweet&sour.jpg") are encoded,
 *      so the "&" cannot truncate the URL into a query string
 *   5. over plain http (no https headers) no image URL is leaked to Messenger
 *   6. the server actually serves /uploads/<file> with image/jpeg
 *
 * Usage: node scripts/test-image-display.cjs
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3210;
const HOST = `localhost:${PORT}`;
const DB = path.join(ROOT, 'data', 'image-test.db');
for (const f of [DB, DB + '-shm', DB + '-wal']) if (fs.existsSync(f)) fs.unlinkSync(f);
// work on a copy of the REAL database (dead URLs included)
for (const ext of ['', '-shm', '-wal']) {
  const src = path.join(ROOT, 'data', 'postre.db' + ext);
  if (fs.existsSync(src)) fs.copyFileSync(src, DB + ext);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
}

(async () => {
  const sdb = new DatabaseSync(DB, { readOnly: true });
  const pkg13 = sdb.prepare('SELECT id, name, photo_url FROM packages WHERE id = 13').get();
  const sfCat = sdb.prepare('SELECT category_id FROM products WHERE id = 64').get(); // Sweet & Sour Fish
  const chCat = sdb.prepare('SELECT category_id FROM products WHERE id = 45').get(); // Chicken Fillet
  const uploadsFile = pkg13.photo_url.replace(/^\/uploads\//, '');
  console.log(`package #13 (${pkg13.name}) -> ${pkg13.photo_url}`);
  console.log(`sweet&sour fish category -> ${sfCat.category_id}\n`);
  // ---------- start server WITHOUT BASE_URL (auto-derivation must kick in) ----------
  const server = spawn('node', ['dist/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_FILE: DB, PORT: String(PORT), PAGE_ACCESS_TOKEN: '',
      BASE_URL: '', JWT_SECRET: 'img-test', VERIFY_TOKEN: 'img-test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => { out += d.toString(); });
  server.stderr.on('data', (d) => { out += d.toString(); });

  for (let i = 0; i < 60 && !out.includes('listening'); i++) await sleep(200);
  if (!out.includes('listening')) throw new Error('server not ready:\n' + out);
  console.log('server ready (no BASE_URL set)\n');

  // like Render's proxy: https in front, plain http to the app
  const httpsHeaders = { 'Content-Type': 'application/json', 'x-forwarded-proto': 'https', host: HOST };
  const sendEvent = (messaging, headers = httpsHeaders) => fetch(`http://${HOST}/webhook`, {
    method: 'POST', headers,
    body: JSON.stringify({ object: 'page', entry: [{ id: 'PAGE', time: Date.now(), messaging: [messaging] }] }),
  }).then((r) => r.text());
  const postback = (payload, h) => sendEvent({ sender: { id: 'IMGTEST' }, recipient: { id: 'PAGE' }, timestamp: Date.now(), postback: { payload, title: payload } }, h);
  const settle = (ms = 14000) => sleep(ms);

  // ---------- 1) packages carousel: relative /uploads + live + dead supabase ----------
  await postback('MENU_PACKAGES');
  await settle();

  const builtUploads = `https://${HOST}/uploads/${uploadsFile}`;
  check('1. relative /uploads image resolved to absolute https URL from request origin (no BASE_URL)',
    out.includes(builtUploads), `expected ${builtUploads} in output`);
  check('2. C1/C2/C3 live Supabase images kept with cache-buster',
    /combo_1787887160135_83AB9AD6-D8BA-4793-AE95-E73584BFB8F7\.jpeg\?v=\d+/.test(out) &&
    /combo_1787887395250_phonto\.jpeg\?v=\d+/.test(out));
  check('3. dead Supabase images dropped by pre-flight (400 logged)',
    out.includes('image pre-flight 400'), 'no pre-flight 400 log found');
  check('3b. dropped images NOT in the final payload',
    !/template_type.:"generic"[\s\S]*E1\.jpg/.test(out));
  check('3c. live images present in the sent generic template payload',
    /mock-send[\s\S]*template_type.:"generic"[\s\S]*combo_1787887395250_phonto\.jpeg\?v=\d+/.test(out));

  // ---------- 2) & encoding (Sweet & Sour Fish -> sweet&sour.jpg) ----------
  out = ''; // reset buffer for focused assertions
  await postback(`CAT:${sfCat.category_id}`);
  await settle();
  check('4. "sweet&sour.jpg" encoded as sweet%26sour.jpg (raw & would truncate the URL)',
    /sweet%26sour\.jpg/.test(out), 'encoded URL not found; tail: ' + out.slice(-600));

  // space encoding lives in the chicken category ("chicken fillet.jpg")
  out = '';
  await postback(`CAT:${chCat.category_id}`);
  await settle();
  check('4b. space in "chicken fillet.jpg" encoded as %20',
    /chicken%20fillet\.jpg/.test(out), 'encoded space not found');

  // ---------- 3) plain http webhook (no https proxy headers) ----------
  out = '';
  await postback('MENU_PACKAGES', { 'Content-Type': 'application/json' });
  await settle();
  check('5. no http:// image URLs leaked when origin is not https',
    !new RegExp(`image_url[^}]*http://${HOST.replace('.', '\\.')}`).test(out),
    (out.match(new RegExp(`http://${HOST.replace('.', '\\.')}[^"]*`, 'g')) || []).slice(0, 3).join(' '));

  // ---------- 4) the /uploads file is actually served ----------
  const img = await fetch(`http://${HOST}/uploads/${uploadsFile}`);
  const buf = Buffer.from(await img.arrayBuffer());
  check('6. /uploads/<file> served as image/jpeg',
    img.status === 200 && (img.headers.get('content-type') || '').startsWith('image/jpeg') && buf.length > 100000,
    `status=${img.status} ct=${img.headers.get('content-type')} bytes=${buf.length}`);

  server.kill();
  await sleep(300);
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
