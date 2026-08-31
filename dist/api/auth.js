"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loginHandler = loginHandler;
exports.authMiddleware = authMiddleware;
exports.requireRole = requireRole;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const database_1 = require("../db/database");
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
function loginHandler(req, res) {
    const { username, password } = req.body || {};
    if (!username || !password)
        return res.status(400).json({ error: 'Missing credentials' });
    const admin = database_1.db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
    if (!admin || !bcryptjs_1.default.compareSync(password, admin.password_hash)) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    const role = admin.role || 'ADMIN';
    const token = jsonwebtoken_1.default.sign({ sub: admin.id, username: admin.username, role }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, id: admin.id, username: admin.username, role });
}
function authMiddleware(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
        return res.status(401).json({ error: 'Unauthorized' });
    try {
        req.admin = jsonwebtoken_1.default.verify(header.slice(7), JWT_SECRET);
        next();
    }
    catch {
        res.status(401).json({ error: 'Unauthorized' });
    }
}
/** Restrict a route to a specific admin role (e.g. only full ADMINs may manage staff accounts). */
function requireRole(role) {
    return (req, res, next) => {
        const admin = req.admin;
        // Tokens issued before roles existed belong to the original owner account → treat as ADMIN.
        if (!admin || (admin.role || 'ADMIN') !== role) {
            return res.status(403).json({ error: 'Forbidden: admin role required' });
        }
        next();
    };
}
