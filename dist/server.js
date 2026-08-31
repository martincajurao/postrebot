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
const app = (0, express_1.default)();
app.use(express_1.default.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
(0, database_1.migrate)();
// Messenger webhook (verification + events) â€” must be before JSON-only routes matter
app.use('/webhook', webhook_1.default);
// Auth
app.post('/api/login', auth_1.loginHandler);
// Admin panel static files
app.use('/admin', express_1.default.static(path_1.default.join(__dirname, 'public', 'admin')));
// Admin API (JWT protected)
app.use('/api/admin', admin_1.default);
app.use('/uploads', express_1.default.static(path_1.default.join(process.cwd(), (process.env.UPLOAD_DIR || './data/uploads').replace('./', ''))));
app.use('/api/admin', upload_1.default);
app.get('/health', (_req, res) => res.json({ ok: true }));
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
});
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Postre server listening on http://localhost:${PORT}`));
