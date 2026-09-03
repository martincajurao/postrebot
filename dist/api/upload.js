"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const auth_1 = require("./auth");
const database_1 = require("../db/database");
const supabase_storage_1 = require("./supabase-storage");
/**
 * Images are stored completely in Supabase Storage (full CRUD):
 *  - CREATE  → POST   /api/admin/upload        (multipart field "image")
 *  - READ    → GET    /api/admin/uploads-list  (bucket listing + public URLs)
 *  - UPDATE  → POST   /api/admin/upload with "name" field of an existing file (upsert replaces bytes)
 *  - DELETE  → DELETE /api/admin/uploads/:name (bucket + DB references)
 * The SQLite `uploads` table only keeps lightweight metadata (name, mime, URL).
 */
const ALLOWED = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: MAX_BYTES },
    fileFilter: (_req, file, cb) => {
        const ext = path_1.default.extname(file.originalname).toLowerCase();
        if (!ALLOWED.includes(ext))
            return cb(new Error('Only jpg, png, webp, gif allowed'));
        cb(null, true);
    },
});
const r = (0, express_1.Router)();
r.use(auth_1.authMiddleware);
/** CREATE / UPDATE (upsert) — multipart/form-data with field "image" */
r.post('/upload', upload.single('image'), async (req, res) => {
    if (!req.file)
        return res.status(400).json({ error: 'No file uploaded (field name must be "image")' });
    if (!(0, supabase_storage_1.configured)())
        return res.status(500).json({ error: 'Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY)' });
    const ext = (path_1.default.extname(req.file.originalname || '') || '.jpg').toLowerCase();
    // UPDATE: pass name=<existing file> (form field or query) to replace its bytes in place.
    // CREATE: a fresh unique filename is generated.
    const reqName = req.body?.name ? String(req.body.name) : req.query.name ? String(req.query.name) : '';
    const name = reqName
        ? reqName.replace(/[^\w.-]/g, '')
        : `${Date.now()}-${crypto_1.default.randomBytes(4).toString('hex')}${ext}`;
    const mime = MIME[ext] || req.file.mimetype || 'application/octet-stream';
    try {
        const url = await (0, supabase_storage_1.uploadImage)(name, mime, req.file.buffer);
        // metadata row: the admin picker has a stable local index of the bucket
        database_1.db.prepare('INSERT OR REPLACE INTO uploads (name, mime, bytes, public_url) VALUES (?, ?, ?, ?)')
            .run(name, mime, Buffer.alloc(0), url);
        return res.json({ url, name, storage: 'supabase' });
    }
    catch (e) {
        console.error('[upload] supabase error:', e.message);
        return res.status(500).json({ error: e.message });
    }
});
/** READ — list all images living in the Supabase bucket. */
r.get('/uploads-list', async (_req, res) => {
    if (!(0, supabase_storage_1.configured)())
        return res.status(500).json({ error: 'Supabase is not configured' });
    try {
        const files = (await (0, supabase_storage_1.listImages)()).map((f) => ({ url: f.url, name: f.name, updated_at: f.updated_at }));
        files.sort((a, b) => String(b.updated_at || b.name).localeCompare(String(a.updated_at || a.name)));
        return res.json(files);
    }
    catch (e) {
        console.error('[uploads-list] error:', e.message);
        return res.status(500).json({ error: e.message });
    }
});
/** DELETE — removes the object from Supabase Storage and clears DB references. */
r.delete('/uploads/:name', async (req, res) => {
    const name = String(req.params.name).replace(/[^\w.-]/g, '');
    if (!name)
        return res.status(400).json({ error: 'Invalid file name' });
    if (!(0, supabase_storage_1.configured)())
        return res.status(500).json({ error: 'Supabase is not configured' });
    try {
        await (0, supabase_storage_1.deleteImages)([name]);
        database_1.db.prepare('DELETE FROM uploads WHERE name = ?').run(name);
        // Detach any product/package photo pointing at this image.
        const url = (0, supabase_storage_1.publicUrl)(name);
        for (const [t, c] of [['products', 'photo_url'], ['packages', 'photo_url']]) {
            database_1.db.prepare(`UPDATE ${t} SET ${c} = NULL WHERE ${c} = ? OR ${c} LIKE ?`).run(url, `%/${name}`);
        }
        return res.json({ ok: true, deleted: name });
    }
    catch (e) {
        console.error('[delete upload] error:', e.message);
        return res.status(500).json({ error: e.message });
    }
});
exports.default = r;
