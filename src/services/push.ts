import webpush from 'web-push';
import { many, run } from '../db';

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@postre.example';
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';

let configured = false;

export function isPushConfigured(): boolean {
  return configured;
}

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY;
}

export function configurePush(): void {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.warn('[push] VAPID keys not set in .env — web push notifications disabled.');
    return;
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  console.log('[push] VAPID configured — web push notifications enabled.');
}

export interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function storeSubscription(sub: PushSubscription, userAgent?: string): Promise<void> {
    const now = new Date().toISOString();
  await run(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, updated_at = excluded.updated_at`,
    [sub.endpoint, sub.p256dh, sub.auth, userAgent ?? null, now],
  );
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await run('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  data?: Record<string, unknown>;
}

export async function sendPushToAdmins(payload: PushPayload): Promise<void> {
  if (!configured) return;
  const subs = await many('SELECT endpoint, p256dh, auth FROM push_subscriptions') as any[];
  if (subs.length === 0) return;

  const notification = JSON.stringify({
    title: payload.title,
    body: payload.body,
    icon: payload.icon || '/admin/icon-192.svg',
    data: payload.data || {},
  });

  const results = await Promise.allSettled(
    subs.map((s) =>
      webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        notification,
      ).catch(async (err: any) => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await removeSubscription(s.endpoint);
        } else {
          throw err;
        }
      }),
    ),
  );

  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) console.warn(`[push] ${failed}/${subs.length} notifications failed to send.`);
}
