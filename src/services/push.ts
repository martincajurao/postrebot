import webpush from 'web-push';
import { supa } from '../db/supabase';

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
    console.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are NOT set — web push notifications DISABLED.');
    console.warn('[push] Fix: run `npm run gen:vapid`, then add the keys to the server environment (Render → Environment) and restart.');
    return;
  }
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    configured = true;
    console.log('[push] VAPID configured — web push notifications ENABLED.');
  } catch (err) {
    console.error('[push] Failed to set VAPID details (check the key values):', err);
  }
}

export interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function storeSubscription(sub: PushSubscription, userAgent?: string): Promise<void> {
  const now = new Date().toISOString();
  const { data: existing } = await supa().from('push_subscriptions').select('endpoint').eq('endpoint', sub.endpoint).maybeSingle();
  if (existing) {
    await supa().from('push_subscriptions').update({ p256dh: sub.p256dh, auth: sub.auth, user_agent: userAgent ?? null, updated_at: now }).eq('endpoint', sub.endpoint);
  } else {
    await supa().from('push_subscriptions').insert({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, user_agent: userAgent ?? null, updated_at: now });
  }
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await supa().from('push_subscriptions').delete().eq('endpoint', endpoint);
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  tag?: string;
  data?: Record<string, unknown>;
}

export interface PushSendResult {
  total: number;
  sent: number;
  failed: number;
}

export async function sendPushToAdmins(payload: PushPayload): Promise<PushSendResult> {
  const result: PushSendResult = { total: 0, sent: 0, failed: 0 };
  if (!configured) {
    console.warn('[push] Send skipped — VAPID keys are not configured in the server environment.');
    return result;
  }
  const { data: subs } = await supa().from('push_subscriptions').select('endpoint, p256dh, auth');
  result.total = subs?.length || 0;
  if (!subs || subs.length === 0) {
    console.warn('[push] Send skipped — no devices subscribed yet. Open /admin → Settings → Push Notifications to subscribe.');
    return result;
  }

  const notification = JSON.stringify({
    title: payload.title,
    body: payload.body,
    icon: payload.icon || '/admin/icon-192.svg',
    tag: payload.tag || 'new-order',
    data: payload.data || {},
  });

  await Promise.allSettled(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        notification,
      );
      result.sent++;
    } catch (err: any) {
      result.failed++;
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        console.warn(`[push] Subscription gone (${err.statusCode}) — removing ${String(s.endpoint).slice(0, 72)}…`);
        await removeSubscription(s.endpoint).catch(() => {});
      } else {
        console.error(`[push] Send failed (${err?.statusCode ?? 'no status'}): ${err?.message ?? err}` +
          (err?.body ? ` | body: ${String(err.body).slice(0, 200)}` : ''));
      }
    }
  }));

  console.log(`[push] Delivered ${result.sent}/${result.total} push notification(s) (${result.failed} failed).`);
  return result;
}

export async function getPushStatus(): Promise<{ configured: boolean; subscriptions: number }> {
  let subscriptions = 0;
  try {
    const { count } = await supa().from('push_subscriptions').select('*', { count: 'exact', head: true });
    subscriptions = count || 0;
  } catch { /* table may not exist yet */ }
  return { configured, subscriptions };
}
