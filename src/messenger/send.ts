import type { Request, Response } from 'express';
import { supa } from '../db/supabase';

const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';

// ---------- conversation state helpers ----------
export async function getState(psid: string): Promise<{ state: string; ctx: any }> {
  const { data } = await supa()
    .from('conversation_states')
    .select('state, context_json')
    .eq('psid', psid)
    .maybeSingle();
  return { state: data?.state || 'MAIN_MENU', ctx: data?.context_json ? JSON.parse(data.context_json) : {} };
}

export async function setState(psid: string, state: string, ctx: any = {}): Promise<void> {
  const context_json = JSON.stringify(ctx);
  const { data: existing } = await supa()
    .from('conversation_states')
    .select('psid')
    .eq('psid', psid)
    .maybeSingle();
  if (existing) {
    await supa().from('conversation_states').update({ state, context_json }).eq('psid', psid);
  } else {
    await supa().from('conversation_states').insert({ psid, state, context_json });
  }
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

/** Build a web_url button that opens INSIDE Messenger's full-height webview. */
export function webviewButton(url: string, title: string) {
  return {
    type: 'web_url',
    url,
    title: title.slice(0, 20),
    webview_height_ratio: 'full',
    // messenger_extensions only validates on HTTPS — ensureWebviewWhitelisted()
    // gates this flag against the Messenger Profile whitelist before sending.
    messenger_extensions: url.startsWith('https://'),
    webview_shareable: true,
  };
}

/** Send a URL button that opens INSIDE Messenger's built-in in-app browser.
 *  messenger_extensions: true makes it a true in-Messenger webview (closes back into
 *  the chat thread) and loads the MessengerExtensions JS SDK on the page so the webview
 *  can call requestCloseBrowser(). The URL must be HTTPS and whitelisted in the Meta app
 *  dashboard under Messenger > Webview Domains — verified here before sending, with an
 *  external fallback (instead of a rejected message) when it can't be confirmed. */
export async function sendUrlButton(psid: string, text: string, title: string, url: string, messengerExt = true): Promise<SendResult> {
  const https = messengerExt && url.startsWith('https://');
  const sendWith = (ext: boolean) => sendApi({
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
            url,
            title: title.slice(0, 20),
            webview_height_ratio: 'full',
            messenger_extensions: ext,
            webview_shareable: true,
          }],
        },
      },
    },
  });

  if (!https) return sendWith(false);

  // Verify the button URL's origin is whitelisted so Meta actually opens the
  // in-app webview instead of silently demoting the button to an external page.
  const whitelisted = await ensureWebviewWhitelisted(url);
  if (whitelisted) return sendWith(true);

  // Whitelist API check failed (transient error?) — try optimistic: the domain
  // may already be whitelisted manually in the Meta dashboard. If Meta rejects
  // the message because the domain isn't whitelisted, fall back to external.
  const result = await sendWith(true);
  if (result.ok) return result;

  const err = (result.body || '').toLowerCase();
  if (err.includes('whitelisted') || err.includes('messenger_extensions') || err.includes('invalid key')) {
    console.warn('[messenger] webview origin NOT whitelisted — sending external fallback link:', originOf(url));
    return sendWith(false);
  }
  return result; // unrelated error — surface it as-is
}

// ---------- Webview domain whitelisting ----------
// Meta only honors messenger_extensions for URLs whose ORIGIN is whitelisted in
// the Messenger Profile. Origins are cached per process; the whitelist is
// verified/refreshed lazily before every webview button is sent.
const whitelistedOrigins = new Set<string>();
const whitelistInFlight = new Map<string, Promise<boolean>>();

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url.replace(/\/+$/, '');
  }
}

async function fetchWhitelistedDomains(): Promise<string[]> {
  const res = await fetch(`https://graph.facebook.com/v19.0/me/messenger_profile?fields=whitelisted_domains&access_token=${PAGE_TOKEN}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`whitelist lookup failed (${res.status}): ${text}`);
  const json = JSON.parse(text) as { data?: Array<{ whitelisted_domains?: string[] }> };
  return json.data?.[0]?.whitelisted_domains || [];
}

/**
 * Ensure the button URL's origin is whitelisted, then cache the result.
 * - Extracts the origin from the button URL itself (never a mismatched BASE_URL).
 * - MERGES into the existing whitelist — POSTing a single domain would silently
 *   REPLACE the whole list on Meta's side.
 * - Retried lazily on every send until it succeeds; safe to call concurrently.
 */
export function ensureWebviewWhitelisted(buttonUrl: string): Promise<boolean> {
  return whitelistWebviewDomain(buttonUrl);
}

/**
 * Ensure the button URL's origin is whitelisted in the Messenger Profile.
 * Alias for ensureWebviewWhitelisted — see that function for details.
 */
export function whitelistWebviewDomain(buttonUrl: string): Promise<boolean> {
  if (!PAGE_TOKEN) {
    console.log('[whitelist] SKIP: PAGE_ACCESS_TOKEN not set');
    return Promise.resolve(false);
  }
  if (!buttonUrl.startsWith('https://')) {
    console.log(`[whitelist] SKIP: URL not HTTPS: ${buttonUrl}`);
    return Promise.resolve(false);
  }

  const origin = originOf(buttonUrl);
  console.log(`[whitelist] checking origin: ${origin}`);
  if (whitelistedOrigins.has(origin)) {
    console.log(`[whitelist] cache hit — already whitelisted: ${origin}`);
    return Promise.resolve(true);
  }

  const inFlight = whitelistInFlight.get(origin);
  if (inFlight) {
    console.log(`[whitelist] reusing in-flight check for: ${origin}`);
    return inFlight;
  }

  const job = (async () => {
    try {
      // Already whitelisted (earlier boot / dashboard)?
      const existing = await fetchWhitelistedDomains();
      const normalized = existing.map((d) => d.replace(/\/+$/, ''));
      if (normalized.includes(origin)) {
        whitelistedOrigins.add(origin);
        return true;
      }
      // Merge — keep every other whitelisted domain intact.
      const merged = Array.from(new Set([...normalized, origin]));
      const res = await fetch(`https://graph.facebook.com/v19.0/me/messenger_profile?access_token=${PAGE_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ whitelisted_domains: merged }),
      });
      const text = await res.text();
      if (res.ok) {
        console.log(`[messenger] webview domain whitelisted (merged, ${merged.length} domain[s]): ${origin}`);
        whitelistedOrigins.add(origin);
        return true;
      }
      console.error(`[messenger] whitelist failed (${res.status}): ${text}`);
      return false;
    } catch (e: any) {
      console.error('[messenger] whitelist error:', e?.message || e);
      return false;
    } finally {
      whitelistInFlight.delete(origin);
    }
  })();
  whitelistInFlight.set(origin, job);
  return job;
}

/**
 * Register a persistent menu (☰ next to the composer) with the web store entry
 * point, so customers always have an in-Messenger way to open the webview.
 * Uses the same whitelisting gate as message buttons.
 */
export async function setPersistentMenu(webviewBaseUrl: string): Promise<boolean> {
  if (!PAGE_TOKEN) {
    console.log('[messenger] skip persistent menu (no PAGE_ACCESS_TOKEN configured)');
    return false;
  }
  const webviewUrl = webviewBaseUrl.replace(/\/+$/, '') + '/webview';
  const whitelisted = await ensureWebviewWhitelisted(webviewUrl);
  const payload = {
    persistent_menu: [
      {
        locale: 'default',
        composer_input_disabled: false,
        call_to_actions: [
          {
            type: 'web_url',
            title: '🌐 Order Online',
            url: webviewUrl,
            webview_height_ratio: 'full',
            messenger_extensions: whitelisted,
          },
          {
            type: 'postback',
            title: '📋 Main Menu',
            payload: 'MAIN_MENU',
          },
        ],
      },
    ],
  };
  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/me/messenger_profile?access_token=${PAGE_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (res.ok) {
      console.log(`[messenger] persistent menu set (webview: ${webviewUrl}, extensions: ${whitelisted})`);
      return true;
    }
    console.error(`[messenger] persistent menu failed (${res.status}): ${text}`);
    return false;
  } catch (e: any) {
    console.error('[messenger] persistent menu error:', e?.message || e);
    return false;
  }
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