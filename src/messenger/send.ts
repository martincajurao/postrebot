import type { Request, Response } from 'express';
import { one, run } from '../db';

const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';

// ---------- conversation state helpers ----------
export async function getState(psid: string): Promise<{ state: string; ctx: any }> {
  const row = await one('SELECT state, context_json FROM conversation_states WHERE psid = $1', [psid]) as any;
  return { state: row?.state || 'MAIN_MENU', ctx: row?.context_json ? JSON.parse(row.context_json) : {} };
}

export async function setState(psid: string, state: string, ctx: any = {}): Promise<void> {
  await run(`INSERT INTO conversation_states (psid, state, context_json) VALUES ($1, $2, $3)
    ON CONFLICT(psid) DO UPDATE SET state = excluded.state, context_json = excluded.context_json,
    updated_at = now()::text`, [psid, state, JSON.stringify(ctx)]);
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

/** Send a URL button that opens a web page inside Messenger's built-in browser */
export function sendUrlButton(psid: string, text: string, title: string, url: string): Promise<SendResult> {
  return sendApi({
    recipient: { id: psid },
    messaging_type: 'RESPONSE',
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: text.slice(0, 640),
          buttons: [{
            type: 'web_url',
            title: title.slice(0, 20),
            url: url,
            webview_height_ratio: 'full',
          }],
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
    // and spaces in keys must be encoded - use a ranged GET, which is what
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
    console.warn(`[messenger] image pre-flight error: ${url} - ${e?.message || e}`);
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
  // Never lose the whole carousel because of a bad image - retry without images.
  if (!result.ok && els.some((e) => e.image_url)) {
    console.warn('[messenger] carousel with images failed - retrying without images');
    await send(els.map((e) => ({ ...e, image_url: undefined })));
  }
}

// ---------- notification helpers (used by admin actions) ----------
export function notifyOrderStatus(psid: string, status: string, orderNumber?: string): void {
  const orderRef = orderNumber ? ` (${orderNumber})` : '';
  const messages: Record<string, string> = {
    CONFIRMED: `Good news! Your order${orderRef} has been confirmed and will be prepared soon.`,
    PREPARING: `Your order${orderRef} is now being prepared. We'll let you know when it's ready!`,
    READY: `Your order${orderRef} is ready! Our delivery rider will pick it up shortly.`,
    CANCELLED: `Your order${orderRef} has been cancelled. Contact us if this is unexpected.`,
    COMPLETED: `Your order${orderRef} has been completed. Thank you for ordering from Postre Food Products!`,
  };
  const msg = messages[status];
  if (msg) sendText(psid, msg).catch(() => { });
}

/** Rider has picked up the order - customer is informed it's on the way. */
export function notifyOrderOnTheWay(psid: string, orderNumber?: string): void {
  const orderRef = orderNumber ? ` (${orderNumber})` : '';
  sendText(psid, `Your order${orderRef} has been picked up by our delivery rider and is now on its way!`).catch(() => { });
}

/** Enhanced order confirmation with full details */
export async function sendOrderConfirmation(psid: string, order: any, items: any[]): Promise<void> {
  const itemLines = items.map((item: any) => {
    const pkgItems = item.package_items?.filter(Boolean)?.map((p: any) => `   • Slot ${p.slot_number}: ${p.product_name}${p.upgrade_price > 0 ? ` (+₱${p.upgrade_price})` : ''}`).join('\n');
    return `• ${item.name} x${item.quantity} - ₱${item.line_total}${pkgItems ? '\n' + pkgItems : ''}`;
  }).join('\n');

  const message =
    `✅ ORDER CONFIRMED\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `📋 Order #: ${order.order_number}\n` +
    `💰 Total: ₱${Number(order.total).toLocaleString('en-PH')}\n` +
    `📦 ${order.order_type === 'delivery' ? 'Delivery' : 'Pickup'}${order.address ? `\n📍 ${order.address}` : ''}\n` +
    `📅 ${order.fulfillment_date || 'ASAP'} at ${order.time_slot || 'ASAP'}\n` +
    `💳 ${order.payment_method ? order.payment_method.toUpperCase() : 'COD'}\n` +
    `\n📝 Items:\n${itemLines}\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `We'll keep you updated on your order status!`;

  await sendText(psid, message);
}

/** Send order status with visual progress indicator */
export async function sendOrderStatus(psid: string, order: any, statusHistory: any[]): Promise<void> {
  const statusEmoji: Record<string, string> = {
    PENDING: '⏳',
    CONFIRMED: '✅',
    PREPARING: '👨‍🍳',
    READY: '📦',
    COMPLETED: '🎉',
    CANCELLED: '❌',
  };

  const statusOrder = ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'COMPLETED'];
  const currentStatus = order.status;
  const currentIndex = statusOrder.indexOf(currentStatus);

  const progressBar = statusOrder.map((s, i) => {
    if (s === currentStatus) return '🔵';
    if (i < currentIndex) return '✅';
    if (currentStatus === 'CANCELLED') return '❌';
    return '⚪';
  }).join(' ');

  const message =
    `📦 ORDER STATUS\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `Order #: ${order.order_number}\n` +
    `${progressBar}\n` +
    `${statusEmoji[currentStatus] || ''} ${currentStatus}\n` +
    `\n━━━━━━━━━━━━━━━━━━━\n` +
    `Payment: ${order.payment_status || 'UNPAID'}\n` +
    `Total: ₱${order.total}`;

  await sendText(psid, message);
}

/** Send order history carousel */
export async function sendOrderHistory(psid: string, orders: any[]): Promise<void> {
  if (orders.length === 0) {
    await sendText(psid, 'You have no previous orders.');
    return;
  }

  const statusEmoji: Record<string, string> = {
    PENDING: '⏳',
    CONFIRMED: '✅',
    PREPARING: '👨‍🍳',
    READY: '📦',
    COMPLETED: '🎉',
    CANCELLED: '❌',
  };

  const elements = orders.map((o: any) => ({
    title: `${statusEmoji[o.status] || '📦'} ${o.order_number}`,
    subtitle: `${o.status} • ₱${o.total} • ${o.created_at?.slice(0, 10) || 'N/A'}`,
    buttons: [
      { title: 'View Details', payload: `ORDER_DETAIL:${o.id}` },
      { title: 'Reorder', payload: `REORDER:${o.id}` },
    ],
  }));

  await sendCarousel(psid, elements);
}

/** Send rating request after order completion */
export async function sendRatingRequest(psid: string, orderNumber: string, orderId: number): Promise<void> {
  await sendText(psid, `How was your order (${orderNumber})?`);
  await sendQuickReplies(psid, 'Please rate your experience:', [
    { title: '⭐', payload: `RATE:${orderId}:1` },
    { title: '⭐⭐', payload: `RATE:${orderId}:2` },
    { title: '⭐⭐⭐', payload: `RATE:${orderId}:3` },
    { title: '⭐⭐⭐⭐', payload: `RATE:${orderId}:4` },
    { title: '⭐⭐⭐⭐⭐', payload: `RATE:${orderId}:5` },
  ]);
}