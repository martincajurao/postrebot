import express from 'express';
import 'dotenv/config';
import { migrate, dbType } from './db';
import adminRoutes from './api/admin';
import uploadRoutes from './api/upload';
import { logConfig } from './api/supabase-storage';
import { loginHandler } from './api/auth';
import messengerWebhook from './messenger/webhook';
import webviewApi from './api/webview';
import { configurePush } from './services/push';
import path from 'path';
import fs from 'fs';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));

migrate()
  .then(() => console.log(`[db] migration complete (${dbType()})`))
  .catch((err) => {
    console.error('[db] migration failed:', err);
    process.exit(1);
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
  const { one } = await import('./db');
  const row = await one('SELECT public_url FROM uploads WHERE name = $1', [file]) as any;
  if (!row || !row.public_url) return res.status(404).end();
  return res.redirect(row.public_url);
});
app.use('/api/admin', uploadRoutes);

app.get('/health', (_req, res) => res.json({ ok: true, db: dbType() }));

app.use((err: any, _req: any, res: any, _next: any) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

logConfig();
configurePush();
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  const base = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  console.log(`Postre server listening on http://localhost:${PORT} (db: ${dbType()})`);
  console.log(`Web ordering URL: ${base}/webview`);
  console.log(`⚠️  Remember to whitelist "${base}" in Meta App Dashboard → Messenger → Settings → Webview Domains`);
});