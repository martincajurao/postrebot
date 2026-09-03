import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { authMiddleware } from './auth';
import { run } from '../db';
import { uploadImage, listImages, deleteImages, publicUrl, configured } from './supabase-storage';

const ALLOWED = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const MAX_BYTES = 5 * 1024 * 1024;
const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED.includes(ext)) return cb(new Error('Only jpg, png, webp, gif allowed'));
    cb(null, true);
  },
});

const r = Router();
r.use(authMiddleware);

r.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be "image")' });
  if (!configured()) return res.status(500).json({ error: 'Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY)' });

  const ext = (path.extname(req.file.originalname || '') || '.jpg').toLowerCase();
  const reqName = req.body?.name ? String(req.body.name) : req.query.name ? String(req.query.name) : '';
  const name = reqName
    ? reqName.replace(/[^\w.-]/g, '')
    : `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  const mime = MIME[ext] || req.file.mimetype || 'application/octet-stream';

  try {
    const url = await uploadImage(name, mime, req.file.buffer);
    await run('INSERT INTO uploads (name, mime, bytes, public_url) VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, public_url = EXCLUDED.public_url',
      [name, mime, Buffer.alloc(0), url]);
    return res.json({ url, name, storage: 'supabase' });
  } catch (e: any) {
    console.error('[upload] supabase error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

r.get('/uploads-list', async (_req, res) => {
  if (!configured()) return res.status(500).json({ error: 'Supabase is not configured' });
  try {
    const files = (await listImages()).map((f) => ({ url: f.url, name: f.name, updated_at: f.updated_at }));
    files.sort((a, b) => String(b.updated_at || b.name).localeCompare(String(a.updated_at || a.name)));
    return res.json(files);
  } catch (e: any) {
    console.error('[uploads-list] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

r.delete('/uploads/:name', async (req, res) => {
  const name = String(req.params.name).replace(/[^\w.-]/g, '');
  if (!name) return res.status(400).json({ error: 'Invalid file name' });
  if (!configured()) return res.status(500).json({ error: 'Supabase is not configured' });
  try {
    await deleteImages([name]);
    await run('DELETE FROM uploads WHERE name = $1', [name]);
    const url = publicUrl(name);
    for (const [t, c] of [['products', 'photo_url'], ['packages', 'photo_url']] as const) {
      await run(`UPDATE ${t} SET ${c} = NULL WHERE ${c} = $1 OR ${c} LIKE $2`, [url, `%/${name}`]);
    }
    return res.json({ ok: true, deleted: name });
  } catch (e: any) {
    console.error('[delete upload] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

export default r;