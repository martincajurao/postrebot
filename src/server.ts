﻿import express from 'express';
import 'dotenv/config';
import { migrate } from './db/postgres';
import adminRoutes from './api/admin';
import uploadRoutes from './api/upload';
import { logConfig } from './api/supabase-storage';
import { loginHandler } from './api/auth';
import messengerWebhook from './messenger/webhook';
import webviewApi from './api/webview';
import { whitelistWebviewDomain, setPersistentMenu, fetchWhitelistedDomains, originOf } from './messenger/send';
import { configurePush } from './services/push';
import path from 'path';
import fs from 'fs';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));

migrate()
  .then(() => console.log('[db] migration complete (supabase)'))
  .catch((err) => {
    // Non-fatal: if the schema already exists via Supabase, this just logs.
    // The app must still boot so Messenger/webhook keep working.
    console.error('[db] migration warning (non-fatal):', err?.message || err);
  });

app.use('/webhook', messengerWebhook);
app.post('/api/login', loginHandler);

// Webview ordering interface (REST API + static frontend)
app.use('/api/webview', webviewApi);

// Middleware to configure frame permissions specifically for Messenger webview:
// On Desktop Messenger (facebook.com / messenger.com), the webview is embedded in an iframe.
// We must allow Meta domains in CSP frame-ancestors and ensure X-Frame-Options does not block framing.
const allowMessengerFraming = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://www.messenger.com https://*.messenger.com https://www.facebook.com https://*.facebook.com https://web.facebook.com https://*.fbsbx.com"
  );
  next();
};

app.use('/webview', allowMessengerFraming);
app.use('/webview', express.static(path.join(__dirname, 'public', 'webview'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.removeHeader('X-Frame-Options');
    res.setHeader(
      'Content-Security-Policy',
      "frame-ancestors 'self' https://www.messenger.com https://*.messenger.com https://www.facebook.com https://*.facebook.com https://web.facebook.com https://*.fbsbx.com"
    );
  },
}));

app.use('/admin', express.static(path.join(__dirname, 'public', 'admin'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

app.use('/api/admin', adminRoutes);
app.get('/uploads/:file', async (req, res) => {
  const file = String(req.params.file);
  if (!/^[-\w.]+$/.test(file)) return res.status(400).end();
  // Redirect to Supabase Storage public URL
  const { publicUrl } = require('./api/supabase-storage');
  const url = publicUrl(file);
  if (!url) return res.status(404).end();
  return res.redirect(url);
});
app.use('/api/admin', uploadRoutes);

app.get('/health', (_req, res) => res.json({ ok: true, db: 'supabase' }));

// Webview whitelist inspection — shows what Meta has registered and allows
// force-refreshing the local cache (useful after manually editing the
// Messenger Profile whitelist in the Meta dashboard).
app.get('/whitelist', async (_req, res) => {
  try {
    if (!process.env.PAGE_ACCESS_TOKEN) {
      return res.status(503).json({ error: 'PAGE_ACCESS_TOKEN not set' });
    }
    const domains = await fetchWhitelistedDomains();
    const base = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
    const origin = base ? originOf(base).replace(/\/+$/, '') : null;
    const normalized = domains.map(d => d.replace(/\/+$/, ''));
    const whitelisted = origin ? normalized.includes(origin) : false;
    res.json({
      whitelisted_domains: domains,
      our_origin: origin,
      our_origin_whitelisted: whitelisted,
      count: domains.length,
      note: 'Whitelisted domains must match the HTTPS origin without trailing slash.',
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.use((err: any, _req: any, res: any, _next: any) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

logConfig();
configurePush();
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, async () => {
  let base = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).trim().replace(/\/+$/, '');
  // Automatically upgrade to https if running on Render or any public domain
  if (base.startsWith('http://') && !/localhost|127\.0\.0\.1|\[::1\]/.test(base)) {
    base = base.replace(/^http:\/\//i, 'https://');
  } else if (!base.startsWith('http://') && !base.startsWith('https://')) {
    base = 'https://' + base;
  }

  const hasToken = !!process.env.PAGE_ACCESS_TOKEN;
  console.log(`Postre server listening on http://localhost:${PORT} (db: supabase)`);
  console.log(`Web ordering URL: ${base}/webview`);
  console.log(`[boot] BASE_URL=${process.env.BASE_URL || '(not set)'} | RENDER_EXTERNAL_URL=${process.env.RENDER_EXTERNAL_URL || '(not set)'} | resolved base=${base} | PAGE_ACCESS_TOKEN=${hasToken ? 'set' : 'NOT SET'}`);

  // Register the webview domain with the Messenger Profile API so the
  // "Open Web Store" button (messenger_extensions) opens INSIDE Messenger's
  // in-chat webview instead of being rejected / opening an external browser.
  if (base.startsWith('https://')) {
    try {
      console.log(`[boot] base is HTTPS — ensuring whitelist for: ${base}`);
      const ok = await whitelistWebviewDomain(base);
      console.log(`[boot] whitelistWebviewDomain resolved: ${ok}`);

      // Register persistent menu (☰ "Order Online" entry) after whitelist is established
      console.log(`[boot] registering persistent menu for: ${base}`);
      const menuOk = await setPersistentMenu(base);
      console.log(`[boot] setPersistentMenu resolved: ${menuOk}`);
    } catch (e: any) {
      console.error(`[boot] Messenger webview registration failed:`, e?.message || e);
    }
  } else {
    console.log(`⚠️  BASE_URL is not HTTPS (${base}) — messenger_extensions webview requires HTTPS. Skipping auto-whitelist and persistent menu.`);
  }
});