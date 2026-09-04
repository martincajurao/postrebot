const fs = require('fs');
const { chromium } = require('C:/Users/Mizeri Jiwu/.vscode/extensions/danielsanmedium.dscodegpt-3.24.58/standalone/node_modules/patchright');

(async () => {
  const pass = fs.readFileSync('.env', 'utf8').match(/^ADMIN_PASSWORD=(.*)$/m)[1].trim();
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:3000/admin/', { waitUntil: 'load' });
  await page.fill('#login-user', 'admin');
  await page.fill('#login-pass', pass);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app', { state: 'visible' });

  await page.click('a[data-view="menu"]');
  await page.waitForSelector('#prod-new');
  await page.click('#prod-new');
  await page.waitForSelector('#pf-photo-library-btn');

  // install error trap before opening library
  await page.evaluate(() => {
    window.__errs = [];
    window.addEventListener('error', (e) => window.__errs.push('ERR: ' + e.message + ' @ ' + e.filename + ':' + e.lineno));
  });

  await page.click('#pf-photo-library-btn');
  await page.waitForSelector('#library-grid .library-img', { timeout: 15000 });
  await page.waitForTimeout(1500);

  const info = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('#library-grid .library-img')];
    const modal = document.getElementById('modal-overlay');
    // list ids of product-form photo-related elements
    const ids = [...document.querySelectorAll('[id^="pf-photo"]')].map((e) => e.id);
    return {
      tileCount: tiles.length,
      tileUrls: tiles.map((t) => t.dataset.url).slice(0, 5),
      pfPhotoIds: ids,
      modalShown: modal.classList.contains('show'),
    };
  });
  console.log(JSON.stringify(info, null, 2));

  // click via evaluate (real DOM click)
  await page.evaluate(() => document.querySelector('#library-grid .library-img').click());
  await page.waitForTimeout(1200);

  const after = await page.evaluate(() => ({
    errs: window.__errs,
    modalShown: document.getElementById('modal-overlay').classList.contains('show'),
    hidden: document.getElementById('pf-photo') ? document.getElementById('pf-photo').value : 'NO #pf-photo',
    toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
  }));
  console.log(JSON.stringify(after, null, 2));
  console.log('--- console ---');
  logs.forEach((m) => console.log(m));
  await browser.close();
})().catch((e) => { console.error('SCRIPT FAIL:', e.message); process.exit(1); });
