export default async function run(page, ui) {
  const out = {};
  out.login = await page.evaluate(async () => {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    const j = await r.json();
    if (r.ok) { localStorage.setItem('token', j.token); localStorage.setItem('me', 'admin'); localStorage.setItem('me_id', '1'); localStorage.setItem('role', 'ADMIN'); }
    return { status: r.status, err: j.error || null };
  });
  await page.goto('http://localhost:3000/admin/#dashboard');
  await page.reload();
  await page.waitForSelector('#app .page-title', { timeout: 10000 });
  out.state = await page.evaluate(() => ({
    token: !!localStorage.getItem('token'),
    appVisible: getComputedStyle(document.getElementById('app')).display !== 'none',
    page: (document.querySelector('.page-title') || {}).textContent || null,
    hash: location.hash,
    navCount: document.querySelectorAll('[data-view]').length,
  }));
  return out;
}
