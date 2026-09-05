import express from 'express';
import 'dotenv/config';
import { migrate } from './db/postgres';
import adminRoutes from './api/admin';
import uploadRoutes from './api/upload';
import { logConfig } from './api/supabase-storage';
import { loginHandler } from './api/auth';
import messengerWebhook from './messenger/webhook';
import webviewApi from './api/webview';
import { whitelistWebviewDomain } from './messenger/send';
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
app.use('/webview', express.static(path.join(__dirname, 'public', 'webview'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
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

app.use((err: any, _req: any, res: any, _next: any) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

logConfig();
configurePush();
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  const base = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
  console.log(`Postre server listening on http://localhost:${PORT} (db: supabase)`);
  console.log(`Web ordering URL: ${base}/webview`);
  // Register the webview domain with the Messenger Profile API so the
  // "Open Web Store" button (messenger_extensions) opens INSIDE Messenger's
  // in-chat webview instead of being rejected / opening an external browser.
  if (base.startsWith('https://')) {
    whitelistWebviewDomain(base).catch(() => { /* logged inside */ });
  } else {
    console.log(`⚠️  BASE_URL is not HTTPS (${base}) — messenger_extensions webview requires HTTPS. Skipping auto-whitelist.`);
  }
});