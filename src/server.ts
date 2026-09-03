import express from 'express';
import 'dotenv/config';
import { migrate, dbType } from './db';
import adminRoutes from './api/admin';
import uploadRoutes from './api/upload';
import { logConfig } from './api/supabase-storage';
import { loginHandler } from './api/auth';
import messengerWebhook from './messenger/webhook';
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

app.use('/admin', express.static(path.join(__dirname, 'public', 'admin'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

app.use('/api/admin', adminRoutes);
const uploadsDirs = ['./data/uploads', './dist/data/uploads'].map((d) => path.resolve(process.cwd(), d));
app.get('/uploads/:file', async (req, res) => {
  const file = String(req.params.file);
  if (!/^[-\w.]+$/.test(file)) return res.status(400).end();
  for (const dir of uploadsDirs) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000');
      return res.sendFile(p);
    }
  }
  const { one } = await import('./db');
  const row = await one('SELECT mime, bytes FROM uploads WHERE name = $1', [file]) as any;
  if (!row) return res.status(404).end();
  res.setHeader('Content-Type', row.mime);
  res.setHeader('Cache-Control', 'public, max-age=2592000');
  res.end(Buffer.from(row.bytes));
});
app.use('/api/admin', uploadRoutes);

app.get('/health', (_req, res) => res.json({ ok: true, db: dbType() }));

app.use((err: any, _req: any, res: any, _next: any) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

logConfig();
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Postre server listening on http://localhost:${PORT} (db: ${dbType()})`));