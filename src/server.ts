import express from 'express';
import 'dotenv/config';
import { migrate } from './db/database';
import adminRoutes from './api/admin';
import uploadRoutes from './api/upload';
import { loginHandler } from './api/auth';
import messengerWebhook from './messenger/webhook';
import path from 'path';

const app = express();
// Behind Render's proxy: makes req.protocol honor X-Forwarded-Proto (https),
// which the webhook uses to build absolute image URLs.
app.set('trust proxy', 1);
app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));

migrate();

// Messenger webhook (verification + events) â€” must be before JSON-only routes matter
app.use('/webhook', messengerWebhook);

// Auth
app.post('/api/login', loginHandler);

// Admin panel static files
// no-cache: browser must revalidate on every load so app.js/UI updates apply
// immediately instead of serving a stale cached copy (which caused broken saves).
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// Admin API (JWT protected)
app.use('/api/admin', adminRoutes);
app.use('/uploads', express.static(path.join(process.cwd(), (process.env.UPLOAD_DIR || './data/uploads').replace('./', ''))));
app.use('/api/admin', uploadRoutes);

app.get('/health', (_req, res) => res.json({ ok: true }));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Postre server listening on http://localhost:${PORT}`));
