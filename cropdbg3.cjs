const fs = require('fs');
const { chromium } = require('C:/Users/Mizeri Jiwu/.vscode/extensions/danielsanmedium.dscodegpt-3.24.58/standalone/node_modules/patchright');

(async () => {
  const pass = fs.readFileSync('.env', 'utf8').match(/^ADMIN_PASSWORD=(.*)$/m)[1].trim();
  const debug = process.env.DBG === '1';
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const page = await browser.newPage();
  const consoleMsgs = [];
  page.on('console', (m) => consoleMsgs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:3000/admin/', { waitUntil: 'load' });
  await page.fill('#login-user', 'admin');
  await page.fill('#login-pass', pass);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app', { state: 'visible' });

  await page.click('a[data-view="menu"]');
  await page.waitForSelector('#prod-new');
  await page.click('#prod-new');
  await page.waitForSelector('#pf-photo-library-btn');

  // click From Library
  await page.click('#pf-photo-library-btn');
  await page.waitForSelector('#library-grid .library-img', { timeout: 15000 });
  await page.waitForTimeout(2000);

  // click the first image tile (last so we can also probe pre-click state)
  if (debug) {
    const pre = await page.evaluate(() => ({
      url: location.href,
      gridImgs: [...document.querySelectorAll('#library-grid img')].slice(0, 3).map((i) => ({ src: i.src, complete: i.complete, nw: i.naturalWidth })),
    }));
    console.log('PRE-CLICK:', JSON.stringify(pre, null, 2));
  }
  await page.click('#library-grid .library-img');
  await page.waitForTimeout(1500);

  const state = await page.evaluate(() => {
    const out = {};
    const tile = document.querySelector('#library-grid .library-img');
    out.tileDataUrl = tile ? tile.dataset.url : 'NO TILE';
    out.modalChildIds = [...document.getElementById('modal').querySelectorAll('[id]')].map((e) => e.id).slice(0, 15);
    if (tile) tile.click();
    return out;
  });
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => ({
    toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
  }));
  console.log(JSON.stringify({ ...state, ...after }, null, 2));
  console.log('--- console messages ---');
  consoleMsgs.forEach((m) => console.log(m));
  await browser.close();
})().catch((e) => { console.error('SCRIPT FAIL:', e.message); process.exit(1); });
