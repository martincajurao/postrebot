import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { supa } from '../db/supabase';
import { getSetting } from '../db/supabase-queries';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

export async function loginHandler(req: Request, res: Response) {
  const { username, password, psid, ts, sig } = req.body || {};
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
  const token = issueAdminToken(admin);
  // Messenger webview: remember this PSID so future opens skip the login page
  // ("log in once"). Only honored when the psid arrives bot-signed.
  if (psid && ts && sig && verifyWebviewPsid(String(psid), String(ts), String(sig))) {
    await rememberAdminForPsid(String(psid), { admin_id: Number(admin.id), username: admin.username, role });
  }
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

// ---------- Messenger webview "remembered admin" sessions ----------
// Goal: log in ONCE from the Messenger webview (secret "admin2020" trigger)
// and stay logged in. The bot opens /admin with an HMAC-signed psid; after a
// successful login the server remembers that psid for 30 days (sliding), and
// future opens auto-login via GET /api/admin/remembered.

/** How long a webview login stays remembered (sliding — refreshed on use). */
const REMEMBER_DAYS = 30;
/** How long a signed webview URL stays valid (old chat buttons expire). */
const SIG_WINDOW_MS = 10 * 60 * 1000;

/** Sign a PSID for the admin webview URL (called by the bot). */
export function signWebviewPsid(psid: string, ts = Date.now()): { psid: string; ts: string; sig: string } {
  const p = String(psid);
  const t = String(ts);
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${p}.${t}`).digest('hex');
  return { psid: p, ts: t, sig };
}

/** Verify a bot-signed PSID — correct HMAC AND inside the freshness window. */
export function verifyWebviewPsid(psid: string, ts: string, sig: string): boolean {
  const p = String(psid || '').trim();
  const t = String(ts || '').trim();
  const s = String(sig || '').trim();
  if (!p || !/^\d+$/.test(t) || !s) return false;
  if (Math.abs(Date.now() - Number(t)) > SIG_WINDOW_MS) return false;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${p}.${t}`).digest('hex');
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Issue a 12h admin JWT (same claims as the normal login). */
export function issueAdminToken(admin: { id: number; username: string; role?: string }): string {
  return jwt.sign({ sub: admin.id, username: admin.username, role: admin.role || 'ADMIN' }, JWT_SECRET, { expiresIn: '12h' });
}

export interface RememberedAdmin { admin_id: number; username: string; role: string; }

const rememberKey = (psid: string) => `admin_remember:${psid}`;

/** Remember a successful webview login for this PSID (30-day sliding window). */
export async function rememberAdminForPsid(psid: string, admin: RememberedAdmin): Promise<void> {
  const expiresAt = new Date(Date.now() + REMEMBER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const value = JSON.stringify({ admin_id: admin.admin_id, username: admin.username, role: admin.role || 'ADMIN', expires_at: expiresAt });
  try {
    // Upsert (same pattern as the settings route in admin.ts)
    const { data: existing } = await supa().from('app_settings').select('key').eq('key', rememberKey(psid)).maybeSingle();
    if (existing) {
      await supa().from('app_settings').update({ value, updated_at: new Date().toISOString() }).eq('key', rememberKey(psid));
    } else {
      await supa().from('app_settings').insert({ key: rememberKey(psid), value, updated_at: new Date().toISOString() });
    }
  } catch (e: any) {
    console.error('[auth] failed to remember admin webview session:', e?.message || e);
  }
}

/** Non-expired remembered admin for this PSID, or null. */
export async function getRememberedAdmin(psid: string): Promise<RememberedAdmin | null> {
  try {
    const raw = await getSetting(rememberKey(psid));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.admin_id || !parsed?.username || !parsed?.expires_at) return null;
    if (new Date(parsed.expires_at).getTime() <= Date.now()) return null;
    return { admin_id: Number(parsed.admin_id), username: String(parsed.username), role: String(parsed.role || 'ADMIN') };
  } catch (e: any) {
    console.error('[auth] failed to read remembered admin session:', e?.message || e);
    return null;
  }
}

/** Drop the remembered session for this PSID (webview logout). */
export async function forgetRememberedAdmin(psid: string): Promise<void> {
  try {
    await supa().from('app_settings').delete().eq('key', rememberKey(psid));
  } catch (e: any) {
    console.error('[auth] failed to forget admin webview session:', e?.message || e);
  }
}