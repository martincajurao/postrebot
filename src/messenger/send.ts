import type { Request, Response } from 'express';
import { db } from '../db/database';

const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';

// ---------- conversation state helpers ----------
export function getState(psid: string): { state: string; ctx: any } {
  const row = db.prepare('SELECT state, context_json FROM conversation_states WHERE psid = ?').get(psid) as any;
  return { state: row?.state || 'MAIN_MENU', ctx: row?.context_json ? JSON.parse(row.context_json) : {} };
}

export function setState(psid: string, state: string, ctx: any = {}): void {
  db.prepare(`INSERT INTO conversation_states (psid, state, context_json) VALUES (?, ?, ?)
    ON CONFLICT(psid) DO UPDATE SET state = excluded.state, context_json = excluded.context_json,
    updated_at = datetime('now')`).run(psid, state, JSON.stringify(ctx));
}

// ---------- Messenger send API ----------
export interface SendResult { ok: boolean; status?: number; body?: string; }

async function sendApi(body: any): Promise<SendResult> {
  if (!PAGE_TOKEN) {
    console.log('[messenger:mock-send]', JSON.stringify(body));
    return { ok: true };
  }
  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) console.error(`[messenger] send failed (${res.status}): ${text}`);
    return { ok: res.ok, status: res.status, body: text };
  } catch (e: any) {
    console.error('[messenger] send error:', e?.message || e);
    return { ok: false, body: String(e?.message || e) };
  }
}

export function sendText(psid: string, text: string): Promise<SendResult> {
  return sendApi({ recipient: { id: psid }, message: { text } });
}

export function sendQuickReplies(psid: string, text: string, replies: { title: string; payload: string }[]): Promise<SendResult> {
  return sendApi({
    recipient: { id: psid },
    message: {
      text,
      quick_replies: replies.slice(0, 13).map((r) => ({
        content_type: 'text', title: r.title.slice(0, 20), payload: r.payload,
      })),
    },
  });
}

export function sendButtons(psid: string, text: string, buttons: { title: string; payload: string }[]): Promise<SendResult> {
  return sendApi({
    recipient: { id: psid },
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: text.slice(0, 640),
          buttons: buttons.slice(0, 3).map((b) => ({
            type: 'postback', title: b.title.slice(0, 20), payload: b.payload,
          })),
        },
      },
    },
  });
}

/** Messenger must be able to download carousel images itself; drop any URL it cannot fetch. */
async function imageUrlOk(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    // Supabase Storage rejects HEAD (400) on public objects in some configs,
    // and spaces in keys must be encoded — use a ranged GET, which is what
    // Messenger itself does. Only fetch the first byte to keep it cheap.
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { Range: 'bytes=0-0' },
    });
    clearTimeout(timer);
    // drain & close immediately
    try { await res.arrayBuffer(); } catch { /* ignore */ }
    if (!res.ok && res.status !== 206) {
      console.warn(`[messenger] image pre-flight ${res.status} (${res.headers.get('content-type') || 'no content-type'}): ${url}`);
      return false;
    }
    const ct = res.headers.get('content-type') || '';
    return ct === '' || ct.startsWith('image/');
  } catch (e: any) {
    console.warn(`[messenger] image pre-flight error: ${url} — ${e?.message || e}`);
    return false;
  }
}

export async function sendCarousel(psid: string, elements: any[]): Promise<void> {
  const els = elements.slice(0, 10).map((e) => ({
    title: e.title.slice(0, 80),
    subtitle: (e.subtitle || '').slice(0, 80),
    image_url: e.image_url || undefined,
    buttons: (e.buttons || []).slice(0, 3).map((b: any) => ({
      type: 'postback', title: b.title.slice(0, 20), payload: b.payload,
    })),
  }));

  // Pre-flight: verify every image URL is publicly reachable, drop the broken ones.
  await Promise.all(els.map(async (e) => {
    if (e.image_url && !(await imageUrlOk(e.image_url))) {
      console.warn(`[messenger] dropping unreachable carousel image: ${e.image_url}`);
      e.image_url = undefined;
    }
  }));

  const send = (list: any[]) => sendApi({
    recipient: { id: psid },
    message: {
      attachment: {
        type: 'template',
        payload: { template_type: 'generic', elements: list },
      },
    },
  });

  let result = await send(els);
  // Never lose the whole carousel because of a bad image — retry without images.
  if (!result.ok && els.some((e) => e.image_url)) {
    console.warn('[messenger] carousel with images failed — retrying without images');
    await send(els.map((e) => ({ ...e, image_url: undefined })));
  }
}

// ---------- notification helpers (used by admin actions) ----------
export function notifyOrderStatus(psid: string, status: string): void {
  const messages: Record<string, string> = {
    CONFIRMED: '✅ Your order has been confirmed.',
    PREPARING: '👨‍🍳 Your order is now being prepared.',
    READY: '🎉 Your order is ready!',
    CANCELLED: '❌ Your order has been cancelled. Contact us if this is unexpected.',
    COMPLETED: '🙏 Thank you for ordering from Postre Food Products!',
  };
  const msg = messages[status];
  if (msg) sendText(psid, msg).catch(() => { });
}
