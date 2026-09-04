import fs from 'fs';
const pass = fs.readFileSync('.env', 'utf8').match(/^ADMIN_PASSWORD=(.*)$/m)[1].trim();

export default async function run(page, ui) {
  // login
  await page.fill('#login-user', 'admin');
  await page.fill('#login-pass', pass);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app', { state: 'visible' });

  // go to Menu
  await page.click('a[data-view="menu"]');
  await page.waitForSelector('#prod-new');
  // open product editor
  await page.click('#prod-new');
  await page.waitForSelector('#pf-photo-library-btn');

  // click "From Library"
  await page.click('#pf-photo-library-btn');
  await page.waitForSelector('#library-grid .library-img', { timeout: 15000 });
  await page.waitForTimeout(1500); // let images paint

  // click the FIRST image tile
  await page.click('#library-grid .library-img');
  await page.waitForTimeout(1200);

  const state = await page.evaluate(() => {
    const out = { ids: [] };
    ['pf-photo', 'pf-photo-url', 'pf-photo-prev'].forEach((id) => {
      const el = document.getElementById(id);
      out.ids.push(id + '=' + (el ? 'FOUND' : 'MISSING'));
    });
    const modal = document.getElementById('modal');
    out.modalHasForm = !!modal.querySelector('input') || modal.innerText.includes('New Product');
    out.modalText = modal.innerText.slice(0, 300);
    return out;
  });
  return state;
}
