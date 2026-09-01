/**
 * End-to-end verification for the image + packages changes.
 * Runs against a scratch DB (data/verify.db) with Messenger sends mocked.
 * Usage: node scripts/verify.cjs
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'data', 'verify.db');
for (const f of [DB, DB + '-shm', DB + '-wal']) if (fs.existsSync(f)) fs.unlinkSync(f);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}${cond ? '' : ' ' + extra}`);
  if (!cond) failures++;
}

(async () => {
  // ---------- seed scratch DB ----------
  execSync('node dist/db/seed.js', { cwd: ROOT, env: { ...process.env, DATABASE_FILE: DB }, stdio: 'ignore' });
  const sdb = new DatabaseSync(DB);
  const pkgs = sdb.prepare('SELECT * FROM packages ORDER BY id').all();
  const fixed = pkgs.find((p) => p.is_fixed === 1);
  const custom = pkgs.find((p) => p.is_custom === 1);
  check('seed: a default fixed package exists', !!fixed, JSON.stringify(pkgs.map((p) => ({ id: p.id, name: p.name, is_fixed: p.is_fixed }))));
  check('seed: a custom "build your own" package exists', !!custom);
  const defaults = sdb.prepare(`SELECT ps.slot_number, po.product_id FROM package_slots ps
    JOIN package_options po ON po.slot_id = ps.id WHERE ps.package_id = ? AND po.is_default = 1`).all(fixed.id);
  check('fixed package has a default dish per slot', defaults.length === fixed.selections);

  // ---------- pricing unit checks (legacy object form + custom packages) ----------
  process.env.DATABASE_FILE = DB;
  const { pricePackage, packageDefaults, normalizeChoices } = require(path.join(ROOT, 'dist', 'services', 'pricing.js'));
  const legacyObj = {};
  for (const d of packageDefaults(fixed.id)) legacyObj[d.slot_number] = d.product_id;
  check('legacy object slot choices accepted (was crashing carts)', pricePackage(fixed.id, legacyObj, 'M').total === fixed.base_price);
  const arrChoices = packageDefaults(fixed.id);
  check('L size upgrade applied per dish', pricePackage(fixed.id, arrChoices, 'L').total === fixed.base_price + fixed.selections * 100,
    `got ${pricePackage(fixed.id, arrChoices, 'L').total}`);
  const anyDish = [{ slot_number: 1, product_id: 6 }, { slot_number: 2, product_id: 2 }, { slot_number: 3, product_id: 8 }, { slot_number: 4, product_id: 7 }];
  check('custom package accepts any active dish', pricePackage(custom.id, anyDish, 'M').total === custom.base_price,
    `got ${pricePackage(custom.id, anyDish, 'M').total}`);
  check('custom package L adds default upgrade per dish', pricePackage(custom.id, anyDish, 'L').total === custom.base_price + 4 * 100);
  check('normalizeChoices handles object form', normalizeChoices({ '2': 5 })[0].product_id === 5);

  // ---------- start server with mocked Messenger sends ----------
  const server = spawn('node', ['dist/server.js'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_FILE: DB, PORT: '3100', PAGE_ACCESS_TOKEN: '', BASE_URL: 'http://localhost:3100', JWT_SECRET: 'verify-test', VERIFY_TOKEN: 'verify-test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => { out += d.toString(); });
  server.stderr.on('data', (d) => { out += d.toString(); });

  async function waitReady() {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch('http://localhost:3100/health'); if (r.ok) return; } catch {}
      await sleep(200);
    }
    throw new Error('server not ready:\n' + out);
  }
  await waitReady();
  console.log('server ready on :3100');

  const sendEvent = (messaging) => fetch('http://localhost:3100/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ object: 'page', entry: [{ id: 'PAGE', time: Date.now(), messaging: [messaging] }] }),
  }).then((r) => r.text());
  const postback = (payload) => sendEvent({ sender: { id: 'TESTER' }, recipient: { id: 'PAGE' }, timestamp: Date.now(), postback: { payload, title: payload } });
  const quick = (payload) => sendEvent({ sender: { id: 'TESTER' }, recipient: { id: 'PAGE' }, timestamp: Date.now(), message: { mid: 'm' + Math.random(), text: payload, quick_reply: { payload } } });
  const text = (t) => sendEvent({ sender: { id: 'TESTER' }, recipient: { id: 'PAGE' }, timestamp: Date.now(), message: { mid: 'm' + Math.random(), text: t } });

  async function waitFor(substr, timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (out.includes(substr)) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for "${substr}".\n--- recent output ---\n${out.slice(-2500)}`);
  }

  try {
    // ---------- fixed package flow (previously crashed at View Cart) ----------
    await postback('GET_STARTED');
    await waitFor('Welcome to Postre Food Products');

    await postback('MENU_PACKAGES');
    await waitFor('Fixed: 4 dishes, ready to order');
    await waitFor('Start Building');
    check('packages carousel lists fixed + custom entries', true);

    await postback('MENU_ORDER');
    await waitFor('Choose a category');
    const ic = (hex) => String.fromCodePoint(hex);
    check('category quick replies show icons',
      out.includes(ic(0x1F357) + ' Chicken') && out.includes(ic(0x1F416) + ' Pork') && out.includes(ic(0x1F958) + ' Bilao'),
      'expected icon-prefixed titles (poultry/pig/shallow-pan) in category quick replies');
    check('every seeded category got an icon',
      out.includes(ic(0x1F969) + ' Beef') && out.includes(ic(0x1F35C) + ' Noodles') && out.includes(ic(0x1F370) + ' Desserts'));

    await postback(`PKG:${fixed.id}`);
    await waitFor('This package is ready to order');
    await waitFor(`Add M ₱${fixed.base_price.toLocaleString('en-PH')}`);
    check('fixed package shows contents + Add M/L', out.includes('1. Chicken BBQ'));

    await quick(`PKGADD:${fixed.id}:M:1`);
    await waitFor('to your cart');
    check('fixed package added with authoritative price', out.includes(`Price: ₱${fixed.base_price.toLocaleString('en-PH')}`));

    await quick('MENU_CART');
    await waitFor(`Total: ₱${fixed.base_price.toLocaleString('en-PH')}`);
    check('View Cart works with package items (previous crash)', true);

    await postback('CART_CHECKOUT');
    await waitFor('Delivery or Pickup?');
    await quick('TYPE:delivery');
    await waitFor('delivery address');
    await text('123 Rizal St, Brgy 1, Naga City');
    await waitFor('contact number');
    await text('09171234567');
    await waitFor('special notes');
    await text('none');
    await waitFor('Payment method');
    await quick('PAY:cod');
    await waitFor('Order #PP-');
    check('checkout completes with package in cart', true);

    const orderRow = sdb.prepare(`SELECT o.* FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE c.psid = 'TESTER' ORDER BY o.id DESC LIMIT 1`).get();
    check('order persisted with correct total', orderRow && orderRow.total === fixed.base_price, JSON.stringify(orderRow));
    const pkgItems = sdb.prepare(`SELECT opi.* FROM order_package_items opi
      JOIN order_items oi ON oi.id = opi.order_item_id WHERE oi.order_id = ?`).all(orderRow.id);
    check('package dish breakdown stored on the order', pkgItems.length === fixed.selections, JSON.stringify(pkgItems));

    // ---------- custom package builder flow ----------
    const postback2 = (payload) => sendEvent({ sender: { id: 'BUILDER' }, recipient: { id: 'PAGE' }, timestamp: Date.now(), postback: { payload, title: payload } });
    const quick2 = (payload) => sendEvent({ sender: { id: 'BUILDER' }, recipient: { id: 'PAGE' }, timestamp: Date.now(), message: { mid: 'm' + Math.random(), text: payload, quick_reply: { payload } } });

    await postback2('MENU_PACKAGES');
    await waitFor('Start Building');
    await postback2(`PKG:${custom.id}`);
    await waitFor('(0/4 chosen)');
    await waitFor('Pick #1');
    check('custom package starts empty with Pick #n', true);

    await postback2(`SLOT:${custom.id}:1`);
    await waitFor('Choose dish for slot #1');
    check('custom slot offers ALL menu dishes', out.includes('Beef Steak'));
    await quick2(`CHOICE:${custom.id}:1:6`); // Beef Steak
    await waitFor('(1/4 chosen)');
    await postback2(`SLOT:${custom.id}:2`);
    await waitFor('Choose dish for slot #2');
    await quick2(`CHOICE:${custom.id}:2:2`); // Fried Chicken
    await waitFor('(2/4 chosen)');
    await postback2(`SLOT:${custom.id}:3`);
    await waitFor('Choose dish for slot #3');
    await quick2(`CHOICE:${custom.id}:3:8`); // Palabok
    await waitFor('(3/4 chosen)');
    await postback2(`SLOT:${custom.id}:4`);
    await waitFor('Choose dish for slot #4');
    await quick2(`CHOICE:${custom.id}:4:7`); // Pancit
    await waitFor('(4/4 chosen)');
    check('custom package complete -> Size & Add appears', true);

    await quick2(`PKGSIZE:${custom.id}`);
    await waitFor(`Total M: ₱${custom.base_price.toLocaleString('en-PH')}`);
    await waitFor(`Total L: ₱${(custom.base_price + 400).toLocaleString('en-PH')}`);
    await quick2(`PKGADD:${custom.id}:L:1`);
    await waitFor(`Price: ₱${(custom.base_price + 400).toLocaleString('en-PH')}`);
    check('custom package priced base + L upgrade per dish', true);

    await quick2('MENU_CART');
    await waitFor(`Total: ₱${(custom.base_price + 400).toLocaleString('en-PH')}`);
    check('custom package cart total correct', true);

    const cartRow = sdb.prepare(`SELECT ci.slot_choices FROM cart_items ci JOIN carts c ON c.id = ci.cart_id
      WHERE c.psid = 'BUILDER' AND ci.package_id = ?`).get(custom.id);
    const parsed = JSON.parse(cartRow.slot_choices);
    check('cart stores slot choices as array', Array.isArray(parsed) && parsed.length === 4, cartRow.slot_choices);
  } catch (e) {
    failures++;
    console.error('VERIFY ERROR:', e.message);
  }

  server.kill();
  sdb.close();
  await sleep(500);
  for (const f of [DB, DB + '-shm', DB + '-wal']) {
    for (let i = 0; i < 5; i++) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); break; } catch { await sleep(400); }
    }
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
