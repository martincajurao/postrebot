export default async function run(page, ui) {
  const out = {};
  out.login = await page.evaluate(async () => {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    const j = await r.json();
    localStorage.setItem('token', j.token); localStorage.setItem('me', 'admin');
    localStorage.setItem('me_id', '1'); localStorage.setItem('role', 'ADMIN');
    return { status: r.status };
  });
  await page.evaluate(() => { location.hash = '#dashboard'; });
  await page.reload();
  await page.waitForTimeout(2500);
  out.afterReload = await page.evaluate(() => ({
    token: !!localStorage.getItem('token'),
    appDisplay: getComputedStyle(document.getElementById('app')).display,
    loginDisplay: getComputedStyle(document.getElementById('login-view')).display,
    page: (document.querySelector('.page-title') || {}).textContent || null,
    hash: location.hash,
    navCount: document.querySelectorAll('[data-view]').length,
  }));
  return out;
}
