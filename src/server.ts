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

// PWA assets at root level (manifest, service worksdsdser, icons)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.json')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    if (filePath.endsWith('.js') && filePath.includes('sw')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Service-Worker-Allowed', '/');
    }
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Webview ordering interface (REST API + static frontend)
app.use('/api/webview', webviewApi);

// Middleware to configure frame permissasdasdsaions specifically for Messenger webview:
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

// The admin panel can also be opened INSIDE Messenger's webview (secret chat
// trigger → "Open Admin Panel" button). Desktop Messenger renders webviews in
// an iframe, so /admin needs the same frame permissions as /webview. This also
// restricts framing to same-origin + Meta domains only.
app.use('/admin', allowMessengerFraming);
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

      // Register persistent menu (☰ "Browse Our Menu" entry) after whitelist is established
      console.log(`[boot] registering persistent menu for: ${base}`);
      const menuOk = await setPersistentMenu(base);
      console.log(`[boot] setPersistentMenu resolved: ${menuOk}`);

      // Keep the persistent menu ALWAYS active: re-assert it on a recurring
      // timer so a one-off Meta/network hiccup at boot (or a later API-side
      // remove) can never silently drop the ☰ popup until the next deploy.
      const refreshMs = Math.max(5 * 60 * 1000, Number(process.env.PERSISTENT_MENU_REFRESH_MS || 30 * 60 * 1000));
      const registerMenu = async (backoffMs = refreshMs) => {
        try {
          const ok = await setPersistentMenu(base);
          if (!ok && backoffMs < refreshMs) {
            // Registration failed — retry with exponential backoff (2, 4, 8 … min,
            // capped at the regular refresh cadence) so a bad boot never leaves
            // the ☰ popup missing for hours.
            const next = Math.min(refreshMs, backoffMs * 2);
            console.log(`[menu keep-alive] failed – retrying in ${Math.round(next / 60000)}min`);
            setTimeout(() => registerMenu(next), next);
          } else {
            console.log(`[menu keep-alive] re-registered persistent menu: ${ok}`);
          }
        } catch (e: any) {
          console.error(`[menu keep-alive] refresh failed:`, e?.message || e);
          const next = Math.min(refreshMs, backoffMs * 2);
          setTimeout(() => registerMenu(next), next);
        }
      };
      // Re-assert on a fixed cadence so the ☰ popup is ALWAYS active even if
      // Meta removes it server-side or a boot-time POST was lost.
      setInterval(() => registerMenu(), refreshMs);
      // If the initial registration above failed, retry fast (2 min) instead
      // of waiting out the whole refresh cycle.
      if (!menuOk) {
        console.log('[boot] initial persistent menu registration failed — fast-retry in 2min');
        setTimeout(() => registerMenu(2 * 60 * 1000), 2 * 60 * 1000);
      } else {
        console.log(`[boot] persistent menu keep-alive every ${Math.round(refreshMs / 60000)}min`);
      }
    } catch (e: any) {
      console.error(`[boot] Messenger webview registration failed:`, e?.message || e);
    }
  } else {
    console.log(`⚠️  BASE_URL is not HTTPS (${base}) — messenger_extensions webview requires HTTPS. Skipping auto-whitelist and persistent menu.`);
  }
});