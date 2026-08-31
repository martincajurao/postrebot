import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/database';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

export function loginHandler(req: Request, res: Response) {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username) as any;
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ sub: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    (req as any).admin = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}
