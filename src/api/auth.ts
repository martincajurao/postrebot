import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { supa } from '../db/supabase';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

export async function loginHandler(req: Request, res: Response) {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const { data: admin } = await supa()
    .from('admins')
    .select('*')
    .eq('username', username)
    .maybeSingle();
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const role = admin.role || 'ADMIN';
  const token = jwt.sign({ sub: admin.id, username: admin.username, role }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, id: admin.id, username: admin.username, role });
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

/** Restrict a route to a specific admin role (e.g. only full ADMINs may manage staff accounts). */
export function requireRole(role: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const admin = (req as any).admin;
    // Tokens issued before roles existed belong to the original owner account â†’ treat as ADMIN.
    if (!admin || (admin.role || 'ADMIN') !== role) {
      return res.status(403).json({ error: 'Forbidden: admin role required' });
    }
    next();
  };
}