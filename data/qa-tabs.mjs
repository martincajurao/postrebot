export default async function run(page, ui) {
  const snap = await ui.snapshot();
  const user = snap.match(/@(e\d+) textbox/)?.[1];
  const pass = snap.match(/@e\d+ textbox[\s\S]*?@(e\d+) textbox/)?.[1];
  await ui.fill(user, 'admin');
  await ui.fill(pass, process.env.ADMIN_PASSWORD || 'admin123');
  await ui.click('@e3');
  await page.waitForSelector('#app .page-title, #login-err', { timeout: 8000 });
  const err = await page.locator('#login-err').textContent().catch(() => '');
  if (err) return { error: 'login failed: ' + err };

  const results = {};
  for (const view of ['orders', 'reservations', 'menu', 'packages', 'customers', 'admins', 'delivery', 'settings', 'dashboard']) {
    await page.evaluate((v) => { location.hash = '#' + v; }, view);
    await page.waitForTimeout(900);
    results[view] = {
      hash: await page.evaluate(() => location.hash),
      title: await page.locator('.page-title').textContent().catch(() => '(none)'),
      activeNav: await page.locator('[data-view].active').count(),
      bodyLen: (await page.locator('#main').innerText()).length,
    };
  }
  // reload persistence: session + current tab should survive
  await page.evaluate(() => { location.hash = '#orders'; });
  await page.reload();
  await page.waitForSelector('#app .page-title', { timeout: 8000 });
  results.afterReload = {
    title: await page.locator('.page-title').textContent().catch(() => '(none)'),
    hash: await page.evaluate(() => location.hash),
  };
  return results;
}
