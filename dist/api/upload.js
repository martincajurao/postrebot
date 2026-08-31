"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const crypto_1 = __importDefault(require("crypto"));
const auth_1 = require("./auth");
const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';
fs_1.default.mkdirSync(UPLOAD_DIR, { recursive: true });
const ALLOWED = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
        const ext = path_1.default.extname(file.originalname).toLowerCase();
        cb(null, `${Date.now()}-${crypto_1.default.randomBytes(4).toString('hex')}${ext}`);
    },
});
const upload = (0, multer_1.default)({
    storage,
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
/** POST multipart/form-data with field "image" → { url: "/uploads/<file>" } */
r.post('/upload', upload.single('image'), (req, res) => {
    if (!req.file)
        return res.status(400).json({ error: 'No file uploaded (field name must be "image")' });
    const baseUrl = process.env.BASE_URL || '';
    res.json({ url: `${baseUrl}/uploads/${req.file.filename}` });
});
/** GET /list — uploaded images (for picker) */
r.get('/uploads-list', (_req, res) => {
    const files = fs_1.default.readdirSync(UPLOAD_DIR)
        .filter((f) => ALLOWED.includes(path_1.default.extname(f).toLowerCase()))
        .map((f) => ({ url: `/uploads/${f}`, name: f }))
        .reverse();
    res.json(files);
});
exports.default = r;
