const { chromium } = require('C:/Users/Mizeri Jiwu/.vscode/extensions/danielsanmedium.dscodegpt-3.24.62/standalone/node_modules/patchright');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Users/Mizeri Jiwu/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe',
    args: ['--no-sandbox', '--disable-features=WebRtcRemoteFeature'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  // --- 1. Load home: gate MUST be showing ---
  await page.goto('http://localhost:3000/webview', { waitUntil: 'load', timeout: 25000 });
  await page.waitForSelector('#location-gate:not(.hidden)', { timeout: 20000 });
  await page.waitForTimeout(800);

  const gate1 = await page.evaluate(() => ({
    gateHidden: document.getElementById('location-gate').classList.contains('hidden'),
    mainHidden: document.getElementById('main-content').classList.contains('hidden'),
    gateErrorVisible: !document.getElementById('loc-gate-error').classList.contains('hidden'),
  }));

  // --- 2. Dismiss the gate properly: tap map to drop a pin, fill address, confirm ---
  await page.click('#loc-map');
  await page.waitForSelector('#loc-map .leaflet-marker-icon', { timeout: 10000 });
  await page.waitForTimeout(700);
  await page.fill('#loc-address', '123 Rizal St, Naga City');
  await page.waitForTimeout(400);
  const beforeConfirm = await page.evaluate(() => ({
    address: document.getElementById('loc-address').value,
    confirmDisabled: document.getElementById('loc-confirm-btn').disabled,
    status: document.getElementById('loc-status').textContent,
    errorVisible: !document.getElementById('loc-gate-error').classList.contains('hidden'),
  }));
  await page.click('#loc-confirm-btn');
  await page.waitForTimeout(900);
  const afterConfirm = await page.evaluate(() => ({
    gateHidden: document.getElementById('location-gate').classList.contains('hidden'),
    mainVisible: !document.getElementById('main-content').classList.contains('hidden'),
  }));

  console.log('DEBUG afterConfirm:', JSON.stringify(afterConfirm));
  console.log('DEBUG beforeConfirm:', JSON.stringify(beforeConfirm));

  // --- 3. Verify the promoted-packages home ---
  await page.waitForSelector('#main-content:not(.hidden)', { timeout: 10000 });
  await page.waitForTimeout(700);

  const layout = await page.evaluate(() => {
    const main = document.getElementById('main-content');
    const sections = [];
    main.querySelectorAll('section, [data-section]').forEach(el => {
      if (el.closest('#main-content') || el.id === 'main-content') {
        const sec = el.tagName === 'SECTION' ? el : el.querySelector('section');
        if (sec) sections.push({ tag: sec.tagName, id: sec.id, cls: sec.className });
      }
    });
    const packagesEl = document.querySelector('[data-section="packages"], #packages-section, .packages-section');
    const firstSec = sections.find(s => s.id === 'view-categories' || s.classList.contains('view-categories') || s.id === 'category-sections' || s.classList.contains('fp-sections')) || sections[0] || null;
    const firstContent = firstSec && firstSec.tagName ? firstSec.querySelector('.fp-promo-banner, [data-section="packages"], .packages-section, .fp-section, .fp-rail, .promo-banner, h2, h3') : null;
    return {
      mainHidden: main.classList.contains('hidden'),
      sections: sections.map(s => ({ id: s.id, cls: s.cls })),
      packagesExists: !!packagesEl,
      packagesSectionId: packagesEl ? (packagesEl.id || (packagesEl.getAttribute('data-section') || 'NO_ID')) : 'NOT_FOUND',
      firstVisibleSec: firstSec ? { id: firstSec.id, cls: firstSec.cls } : null,
      firstVisibleContent: firstContent ? firstContent.tagName + (firstContent.id ? '#' + firstContent.id : '') : null,
      promoBanner: !!document.querySelector('.fp-promo-banner, .promo-banner'),
      hasCatRail: !!document.querySelector('.fp-cat-rail'),
      hasCategorySections: !!document.querySelector('.fp-section[data-category]'),
      packageCards: packagesEl ? packagesEl.querySelectorAll('.fp-card').length : 0,
    };
  });

  // --- 4. Reload: gate MUST reappear (always-on behavior) ---
  await page.reload({ waitUntil: 'load', timeout: 25000 });
  await page.waitForTimeout(1200);
  const gateReload = await page.evaluate(() => ({
    gateHidden: document.getElementById('location-gate').classList.contains('hidden'),
    mainHidden: document.getElementById('main-content').classList.contains('hidden'),
  }));

  await browser.close();

  console.log('GATE_FIRST_OPEN:', JSON.stringify(gate1));
  console.log('DISMISS:', JSON.stringify({ beforeConfirm, afterConfirm }));
  console.log('HOME_LAYOUT:', JSON.stringify(layout));
  console.log('GATE_RELOAD:', JSON.stringify(gateReload));
  console.log('ERRORS:', JSON.stringify(errors));

  // --- PASS criteria ---
  const pass =
    // Gate on first open
    gate1.gateHidden === false && gate1.mainHidden === true && gate1.gateErrorVisible === false &&
    // Dismiss works (map pin + valid address)
    beforeConfirm.address.length >= 5 && !beforeConfirm.confirmDisabled && beforeConfirm.errorVisible === false &&
    afterConfirm.gateHidden === true && afterConfirm.mainVisible === true &&
    // Promoted packages home
    layout.mainHidden === false &&
    layout.packagesExists === true &&
    (layout.firstVisibleSec && layout.firstVisibleSec.cls && layout.firstVisibleSec.cls.includes('packages')) &&
    layout.hasCatRail === false &&
    layout.hasCategorySections === true &&
    layout.packageCards >= 1 &&
    // Gate reappears on reload (always-on)
    gateReload.gateHidden === false &&
    gateReload.mainHidden === true &&
    // No console errors
    errors.length === 0;

  console.log('PASS:', pass);
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
