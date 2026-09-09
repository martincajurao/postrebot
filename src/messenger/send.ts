﻿import type { Request, Response } from 'express';
import { supa } from '../db/supabase';
import { getReservationByOrderId } from '../services/reservations';
import { getOrderItems } from '../services/orders';

const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';

// Graph API version - v19.0 expired May 21, 2026. Using v22.0 (stable, supported until May 20, 2027).
// See: https://developers.facebook.com/docs/graph-api/changelog
export const GRAPH_API_VERSION = 'v22.0';

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
  const targetUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages`;
  const requestBody = JSON.stringify(body);
  try {
    // Log COMPLETE non-secret payload for diagnostics
    console.log(`[messenger:sendApi] POST ${targetUrl}`);
    console.log(`[messenger:sendApi] PAYLOAD: ${requestBody}`);
    const res = await fetch(`${targetUrl}?access_token=${PAGE_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
    });
    const text = await res.text();
    // Log COMPLETE non-secret response for diagnostics
    console.log(`[messenger:sendApi] RESPONSE STATUS: ${res.status}`);
    console.log(`[messenger:sendApi] RESPONSE BODY: ${text}`);
    if (!res.ok) {
      // Parse Meta error details for better logging
      try {
        const errJson = JSON.parse(text);
        const err = errJson?.error || {};
        console.error(`[messenger] Meta error: code=${err.code}, type=${err.type}, message=${err.message}, subcode=${err.error_subcode}`);
      } catch { /* not JSON */ }
    }
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
  const isHttps = url.startsWith('https://');
  const btn: any = {
    type: 'web_url',
    url,
    title: title.slice(0, 20),
    webview_height_ratio: 'full',
  };
  if (isHttps) {
    btn.messenger_extensions = true;
    btn.fallback_url = url;
  }
  return btn;
}

/** Send a URL button that opens INSIDE Messenger's built-in in-app browser.
 *  messenger_extensions: true makes it a true in-Messenger webview (closes back into
 *  the chat thread) and loads the MessengerExtensions JS SDK on the page so the webview
 *  can call requestCloseBrowser(). Meta requirements:
 *  1. URL must be HTTPS
 *  2. Domain origin must be in whitelisted_domains
 *  3. fallback_url must be provided when messenger_extensions is true
 *  4. webview_height_ratio: 'full'
 *
 * IMPORTANT: We do NOT silently fall back to an external browser when webview fails.
 * If the webview request fails, we log the exact Meta API response and preserve the error.
 * This ensures the failure is visible and can be addressed, rather than silently degrading
 * to a poor user experience. */
export async function sendUrlButton(psid: string, text: string, title: string, url: string, messengerExt = true): Promise<SendResult> {
  const isHttps = messengerExt && url.startsWith('https://');
  console.log(`[sendUrlButton] START psid=${psid} | url=${url} | isHttps=${isHttps} | messengerExt=${messengerExt}`);

  const sendWith = (ext: boolean) => {
    const button: any = {
      type: 'web_url',
      url,
      title: title.slice(0, 20),
      webview_height_ratio: 'full',
    };
    if (ext) {
      button.messenger_extensions = true;
      button.fallback_url = url;
    }
    console.log(`[sendUrlButton] BUTTON TYPE: ${button.type}`);
    console.log(`[sendUrlButton] BUTTON PAYLOAD: ${JSON.stringify(button)}`);
    return sendApi({
      recipient: { id: psid },
      messaging_type: 'RESPONSE',
      message: {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: text.slice(0, 640),
            buttons: [button],
          },
        },
      },
    });
  };

  if (!isHttps) {
    console.error('[sendUrlButton] URL is not HTTPS — cannot use messenger_extensions. Sending as external link.');
    return sendWith(false);
  }

  // Verify origin is whitelisted (uses in-memory cache, avoids blocking every tap with a Meta API call)
  console.log(`[sendUrlButton] Checking whitelist for origin=${originOf(url)}`);
  const whitelisted = await ensureWebviewWhitelisted(url);
  console.log(`[sendUrlButton] ensureWebviewWhitelisted=${whitelisted} for origin=${originOf(url)}`);

  if (!whitelisted) {
    // Whitelist check failed — do NOT silently fall back to external link.
    // Log the error and return failure so the issue is visible.
    const errMsg = `[sendUrlButton] CRITICAL: Domain not whitelisted. Cannot open webview. Origin=${originOf(url)}. Add this domain to Page Settings → Advanced Messaging → Whitelisted domains.`;
    console.error(errMsg);
    return { ok: false, status: 0, body: errMsg };
  }

  // Domain is whitelisted — send with messenger_extensions=true
  console.log(`[sendUrlButton] Domain whitelisted. Sending with messenger_extensions=true...`);
  const result = await sendWith(true);
  console.log(`[sendUrlButton] RESULT ok=${result.ok} | status=${result.status} | body=${result.body}`);

  if (result.ok) {
    console.log(`[sendUrlButton] SUCCESS: WebView button sent successfully.`);
    return result;
  }

  // Send failed — log the exact Meta API response for debugging
  const err = (result.body || '').toLowerCase();
  console.error(`[sendUrlButton] FAILURE: messenger_extensions=true was rejected by Meta.`);
  console.error(`[sendUrlButton] Full Meta response: ${result.body}`);

  if (err.includes('whitelisted') || err.includes('domain') || err.includes('messenger_extensions')) {
    // Clear cache so we re-verify on next attempt
    whitelistedOrigins.delete(originOf(url).replace(/\/+$/, ''));
    console.error(`[sendUrlButton] Domain whitelist issue detected. Cleared cache for: ${originOf(url)}`);
  }

  // DO NOT fall back to external link — preserve the error so it's visible
  console.error(`[sendUrlButton] NOT falling back to external browser. Preserving error for visibility.`);
  return result;
}

// ---------- Webview domain whitelisting ----------
// Meta only honors messenger_extensions for URLs whose ORIGIN is whitelisted in
// the Messenger Profile. Origins are cached per process; the whitelist is
// verified/refreshed lazily before every webview button is sent.
const whitelistedOrigins = new Set<string>();
const whitelistInFlight = new Map<string, Promise<boolean>>();

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url.replace(/\/+$/, '');
  }
}

export async function fetchWhitelistedDomains(): Promise<string[]> {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messenger_profile?fields=whitelisted_domains&access_token=${PAGE_TOKEN}`;
  console.log(`[fetchWhitelistedDomains] GET ${url.replace(PAGE_TOKEN, '***')}`);
  const res = await fetch(url);
  const text = await res.text();
  console.log(`[fetchWhitelistedDomains] status=${res.status} body=${text.slice(0, 300)}`);
  if (!res.ok) {
    // Parse Meta error details
    try {
      const errJson = JSON.parse(text);
      const err = errJson?.error || {};
      console.error(`[fetchWhitelistedDomains] Meta error: code=${err.code}, type=${err.type}, message=${err.message}`);
    } catch { /* not JSON */ }
    throw new Error(`whitelist lookup failed (${res.status}): ${text}`);
  }
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
export function ensureWebviewWhitelisted(buttonUrl: string, opts: { force?: boolean } = {}): Promise<boolean> {
  return whitelistWebviewDomain(buttonUrl, opts);
}

/**
 * Ensure the button URL's origin is whitelisted in the Messenger Profile.
 * Alias for ensureWebviewWhitelisted — see that function for details.
 */
export function whitelistWebviewDomain(buttonUrl: string, opts: { force?: boolean } = {}): Promise<boolean> {
  if (!PAGE_TOKEN) {
    console.log('[whitelist] SKIP: PAGE_ACCESS_TOKEN not set');
    return Promise.resolve(false);
  }
  if (!buttonUrl.startsWith('https://')) {
    console.log(`[whitelist] SKIP: URL not HTTPS: ${buttonUrl}`);
    return Promise.resolve(false);
  }

  const origin = originOf(buttonUrl).replace(/\/+$/, '');
  console.log(`[whitelist] checking origin: ${origin} (force=${!!opts.force})`);
  if (!opts.force && whitelistedOrigins.has(origin)) {
    console.log(`[whitelist] cache hit — already whitelisted: ${origin}`);
    return Promise.resolve(true);
  }
  if (opts.force) {
    console.log(`[whitelist] force mode — bypassing cache, re-verifying with Meta`);
  }

  const inFlight = whitelistInFlight.get(origin);
  if (inFlight) {
    console.log(`[whitelist] reusing in-flight check for: ${origin}`);
    return inFlight;
  }

  const job = (async () => {
    try {
      // Always verify against Meta's actual whitelist (source of truth).
      const existing = await fetchWhitelistedDomains();
      const normalized = existing.map((d) => d.replace(/\/+$/, ''));
      console.log(`[whitelist] Meta whitelist: [${normalized.join(', ')}]`);
      if (normalized.includes(origin)) {
        whitelistedOrigins.add(origin);
        return true;
      }
      // Not whitelisted — add it now (merge, clean origins only without trailing slashes).
      const merged = Array.from(new Set([...normalized, origin]));
      console.log(`[whitelist] adding ${origin} to whitelist (merged list: [${merged.join(', ')}])`);
      const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/me/messenger_profile?access_token=${PAGE_TOKEN}`, {
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
      // Parse Meta error details
      try {
        const errJson = JSON.parse(text);
        const err = errJson?.error || {};
        console.error(`[messenger] whitelist POST failed: code=${err.code}, type=${err.type}, message=${err.message}, subcode=${err.error_subcode}`);
      } catch { /* not JSON */ }
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
 * Keep the persistent menu (☰ next to the composer) in sync with what we want.
 * Messenger caches the persistent menu aggressively and re-posting alone does
 * not always replace a previously-registered one, so this is self-healing:
 *   1. GET the menu Meta currently has registered.
 *   2. If it already matches the desired buttons (Browse Our Menu / How to
 *      Order / Contact Us) do nothing.
 *   3. Otherwise CLEAR it (empty call_to_actions) and re-register the desired
 *      one — this permanently drops stale entries (e.g. the old "Order Online"
 *      / "📅 Reservation" buttons) instead of letting them linger.
 */
export async function setPersistentMenu(webviewBaseUrl: string): Promise<boolean> {
  if (!PAGE_TOKEN) {
    console.log('[messenger] skip persistent menu (no PAGE_ACCESS_TOKEN configured)');
    return false;
  }

  const webviewUrl = webviewBaseUrl.replace(/\/+$/, '') + '/webview';
  const whitelisted = await ensureWebviewWhitelisted(webviewUrl);

  const menuButton: any = {
    type: 'web_url',
    title: '🛒 Browse Our Menu',
    url: webviewUrl,
    webview_height_ratio: 'full',
  };
  if (whitelisted) {
    menuButton.messenger_extensions = true;
    menuButton.fallback_url = webviewUrl;
  }

  const desired: any[] = [
    menuButton,
    { type: 'postback', title: '❓ How to Order', payload: 'MENU_HOWTO' },
    { type: 'postback', title: '📞 Contact Us', payload: 'MENU_CONTACT' },
  ];
  const key = (b: any) => `${b.type}|${b.title}` + (b.payload ? `|${b.payload}` : '');
  const desiredKeys = desired.map(key).sort();

  // Compare against what Meta actually has registered (best effort).
  let currentKeys: string[] = [];
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/me/messenger_profile?access_token=${PAGE_TOKEN}&fields=persistent_menu`, { method: 'GET' });
    if (res.ok) {
      const json = await res.json();
      const locales = (json?.data?.[0]?.persistent_menu) || [];
      const def = locales.find((e: any) => e.locale === 'default');
      currentKeys = (def?.call_to_actions || []).map(key).sort();
      console.log(`[setPersistentMenu] Meta currently has: [${currentKeys.join(', ')}]`);
    } else {
      console.error(`[setPersistentMenu] could not read current menu (${res.status}) — will force clear+set`);
    }
  } catch (e: any) {
    console.error('[setPersistentMenu] read current menu failed:', e?.message || e);
  }

  const payload = {
    persistent_menu: [
      {
        locale: 'default',
        composer_input_disabled: false,
        call_to_actions: desired,
      },
    ],
  };

  if (JSON.stringify(currentKeys) === JSON.stringify(desiredKeys) && currentKeys.length > 0) {
    console.log('[setPersistentMenu] persistent menu already up to date — no change needed.');
    return true;
  }

  // Stale or missing menu — clear it first so Messenger drops the old cached
  // buttons, then register the current one.
  console.log('[setPersistentMenu] menu differs — clearing, then re-registering.');
  try {
    await postPersistentMenu({ persistent_menu: [{ locale: 'default', composer_input_disabled: false, call_to_actions: [] }] });
  } catch (e: any) {
    console.error('[setPersistentMenu] clear error:', e?.message || e);
  }
  // Let the clear propagate before re-adding the buttons.
  await new Promise((r) => setTimeout(r, 1500));

  try {
    console.log(`[setPersistentMenu] POST persistent menu with messenger_extensions=${whitelisted} for ${webviewUrl}`);
    return await postPersistentMenu(payload);
  } catch (e: any) {
    console.error('[messenger] persistent menu error:', e?.message || e);
    return false;
  }
}

/** POST a persistent_menu payload to the Messenger Profile API. */
async function postPersistentMenu(payload: any): Promise<boolean> {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/me/messenger_profile?access_token=${PAGE_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (res.ok) {
    console.log('[messenger] persistent menu updated');
    return true;
  }
  // Parse Meta error details
  try {
    const errJson = JSON.parse(text);
    const err = errJson?.error || {};
    console.error(`[setPersistentMenu] Meta error: code=${err.code}, type=${err.type}, message=${err.message}, subcode=${err.error_subcode}`);
  } catch { /* not JSON */ }
  console.error(`[messenger] persistent menu failed (${res.status}): ${text}`);
  return false;
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
export async function notifyOrderStatus(psid: string, status: string, orderNumber?: string, order?: any): Promise<void> {
  const orderRef = orderNumber ? ` (${orderNumber})` : '';
  
  // Build reservation form for CONFIRMED orders with fulfillment date/time
  const buildReservationForm = async (): Promise<string> => {
    if (!order || !order.fulfillment_date) return '';
    
    // Handle customer data - could be nested from join or direct property
    const customer = order.customers || order;
    const customerName = customer.name || order.customer_name || 'N/A';
    const contactNum = customer.phone || order.phone || 'N/A';
    const orderType = order.order_type === 'delivery' ? 'Delivery' : 'Pickup';
    const location = order.address || 'N/A';
    
    // Fetch reservation reference number
    let reservationRef = '';
    if (order.id) {
      const reservation = await getReservationByOrderId(order.id);
      if (reservation) {
        reservationRef = `\n📋 Reservation: RES-${reservation.id}`;
      }
    }

    // Ordered menu items (with package slot choices when present)
    let itemsBlock = '';
    if (order.id) {
      try {
        const items = await getOrderItems(order.id);
        const lines = (items || []).map((item: any) => {
          const pkgItems = item.package_items?.filter(Boolean)?.map((p: any) => `   • Slot ${p.slot_number}: ${p.product_name}${p.upgrade_price > 0 ? ` (+₱${p.upgrade_price})` : ''}`).join('\n');
          return `• ${item.name} x${item.quantity} - ₱${item.line_total}${pkgItems ? '\n' + pkgItems : ''}`;
        });
        if (lines.length) itemsBlock = `\n𝑰𝒕𝒆𝒎𝒔:\n` + lines.join('\n') + `\n`;
      } catch { /* send the form even if items cannot be loaded */ }
    }

    return (
      `\n\n𝙍𝙀𝙎𝙀𝙍𝙑𝘼𝙏𝙄𝙊𝙉 𝙁𝙊𝙍𝙈` +
      `\n━━━━━━━━━━━━━━━━━━━` +
      `\n{𝑷𝒐𝒔𝒕𝒓𝒆 𝑪𝒓𝒆𝒑𝒆 𝒅𝒆 𝑴𝒂𝒏𝒈𝒐'𝒔:` +
      `\n𝑫𝒂𝒕𝒆&𝑻𝒊𝒎𝒆: ${order.fulfillment_date || 'N/A'} ${order.time_slot || ''}` +
      `\n𝑵𝒂𝒎𝒆: ${customerName}` +
      `\n𝑪𝒐𝒏𝒕𝒂𝒄𝒕#: ${contactNum}` +
      `\n𝑶𝒓𝒅𝒆𝒓: ${orderType}` +
      itemsBlock +
      `\n𝑳𝒐𝒄𝒂𝒕𝒊𝒐𝒏,𝒍𝒂𝒏𝒅𝒎𝒂𝒓𝒌: ${location}}` +
      reservationRef
    );
  };
  
  const messages: Record<string, string> = {
    CONFIRMED: `Good news! Your order${orderRef} has been confirmed and will be prepared on scheduled date.`,
    PREPARING: `Your order${orderRef} is now being prepared. We'll let you know when it's ready!`,
    READY: `Your order${orderRef} is ready! Our delivery rider will pick it up shortly.`,
    CANCELLED: `Your order${orderRef} has been cancelled. Contact us if this is unexpected.`,
    COMPLETED: `Your order${orderRef} has been completed. Thank you for ordering from Postre Food Products!`,
  };
  
  let msg = messages[status];
  if (msg && status === 'CONFIRMED') {
    msg += await buildReservationForm();
  }
  if (msg) await sendText(psid, msg);
}

/** Rider has picked up the order - customer is informed it's on the way. */
export function notifyOrderOnTheWay(psid: string, orderNumber?: string): void {
  const orderRef = orderNumber ? ` (${orderNumber})` : '';
  sendText(psid, `🚚 Your order${orderRef} has been picked up by our delivery rider and is now on its way!`).catch(() => { });
}

/** Order-placed receipt: sent right after checkout while the order is still PENDING for admin confirmation. */
export async function sendOrderConfirmation(psid: string, order: any, items: any[]): Promise<void> {
  const itemLines = items.map((item: any) => {
    const pkgItems = item.package_items?.filter(Boolean)?.map((p: any) => `   • Slot ${p.slot_number}: ${p.product_name}${p.upgrade_price > 0 ? ` (+₱${p.upgrade_price})` : ''}`).join('\n');
    return `• ${item.name} x${item.quantity} - ₱${item.line_total}${pkgItems ? '\n' + pkgItems : ''}`;
  }).join('\n');

  const message =
    `🧾 ORDER PLACED\n` +
    `⏳ Status: PENDING FOR CONFIRMATION\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `📋 Order #: ${order.order_number}\n` +
    `${Number(order.discount) > 0 ? `🏷️ Discount: -₱${Number(order.discount).toLocaleString('en-PH')}\n` : ''}` +
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