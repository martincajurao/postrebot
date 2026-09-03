import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { authMiddleware } from './auth';

const UPLOAD_DIR = process.env.UPLOAD_DIR || (fs.existsSync('./data/uploads') ? './data/uploads' : './dist/data/uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED.includes(ext)) return cb(new Error('Only jpg, png, webp, gif allowed'));
    cb(null, true);
  },
});

const r = Router();
r.use(authMiddleware);

/** POST multipart/form-data with field "image" → { url: "/uploads/<file>" } */
r.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be "image")' });
  const baseUrl = process.env.BASE_URL || '';
  // Relative URL: same-origin for the admin panel; absUrl() adds BASE_URL when
  // sending to Messenger. Keeps stored links valid even if the domain changes.
  res.json({ url: `/uploads/${req.file.filename}`, baseUrl });
});

/** GET /list — uploaded images (for picker) */
r.get('/uploads-list', (_req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR)
    .filter((f) => ALLOWED.includes(path.extname(f).toLowerCase()))
    .map((f) => ({ url: `/uploads/${f}`, name: f }))
    .reverse();
  res.json(files);
});

export default r;
