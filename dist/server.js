"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
require("dotenv/config");
const database_1 = require("./db/database");
const admin_1 = __importDefault(require("./api/admin"));
const upload_1 = __importDefault(require("./api/upload"));
const auth_1 = require("./api/auth");
const webhook_1 = __importDefault(require("./messenger/webhook"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const app = (0, express_1.default)();
// Behind Render's proxy: makes req.protocol honor X-Forwarded-Proto (https),
// which the webhook uses to build absolute image URLs.
app.set('trust proxy', 1);
app.use(express_1.default.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
(0, database_1.migrate)();
// Messenger webhook (verification + events) â€” must be before JSON-only routes matter
app.use('/webhook', webhook_1.default);
// Auth
app.post('/api/login', auth_1.loginHandler);
// Admin panel static files
// no-cache: browser must revalidate on every load so app.js/UI updates apply
// immediately instead of serving a stale cached copy (which caused broken saves).
app.use('/admin', express_1.default.static(path_1.default.join(__dirname, 'public', 'admin'), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));
// Admin API (JWT protected)
app.use('/api/admin', admin_1.default);
// Serve uploaded images. Each file is stored INSIDE the SQLite DB (uploads
// table) at upload time, so it survives redeploys that wipe local disk. The
// on-disk copy (./data/uploads, then ./dist/data/uploads) is served when it
// exists; otherwise the bytes come straight from the DB.
const uploadsDirs = ['./data/uploads', './dist/data/uploads'].map((d) => path_1.default.resolve(process.cwd(), d));
app.get('/uploads/:file', (req, res) => {
    const file = String(req.params.file);
    if (!/^[-\w.]+$/.test(file))
        return res.status(400).end();
    for (const dir of uploadsDirs) {
        const p = path_1.default.join(dir, file);
        if (fs_1.default.existsSync(p)) {
            res.setHeader('Cache-Control', 'public, max-age=2592000');
            return res.sendFile(p);
        }
    }
    const row = database_1.db.prepare('SELECT mime, bytes FROM uploads WHERE name = ?').get(file);
    if (!row)
        return res.status(404).end();
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Cache-Control', 'public, max-age=2592000');
    res.end(Buffer.from(row.bytes));
});
app.use('/api/admin', upload_1.default);
app.get('/health', (_req, res) => res.json({ ok: true }));
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
});
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Postre server listening on http://localhost:${PORT}`));
