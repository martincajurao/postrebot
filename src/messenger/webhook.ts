import { Router } from 'express';
import { supa } from '../db/supabase';
import {
  getCustomerByPsid, createCustomer,
  getActiveCategories, getProductsByCategory, getProductById, getProductVariants,
  getVariantByProductAndSize, getFoodPacks, getFoodPackById, getPackageById,
  getPackages, getPackageSlots, getPackageSlotByNumber, getSlotOptions,
  getCustomSlotOptions, getPackageOptionBySlotAndProduct,
} from '../db';
import { getState, setState, sendText, sendQuickReplies, sendButtons, sendCarousel, sendUrlButton, SendResult, sendOrderConfirmation, sendOrderStatus, sendOrderHistory, sendRatingRequest } from './send';
import { getCart, addItem, removeItem, updateQuantity, cartTotals, clearCart, getOrCreateCart } from '../services/cart';
import { createOrderFromCart, getCustomerOrders, getOrderById, getOrderItems, getOrderStatusHistory, cancelOrder, completeOrderByCustomer, rateOrder } from '../services/orders';
import { sendPushToAdmins } from '../services/push';
import { slotAvailability, isDateOpen, createReservation } from '../services/reservations';
import { pricePackage, packageDefaults, computeCartTotals, netPackagePrice } from '../services/pricing';

const r = Router();

// ---------- env-driven configurables (payment/contact/admin) ----------
// Set these in .env so real accounts live in one place, not buried in code.
const PAYMENT_INFO: Record<string, string> = {
  cod: 'Pay in cash when your order arrives.',
  gcash: process.env.PAYMENT_GCASH || 'GCash: 09753122085 (M*rt*n N*ko C.). Send the receipt to confirm.',
  bank: process.env.PAYMENT_BANK || 'BDO: 0000-0000-0000 (Not Available). Send the receipt to confirm.',
};
const CONTACT_INFO = {
  phone: process.env.CONTACT_PHONE || '0917-000-0000',
  email: process.env.CONTACT_EMAIL || 'hello@postre.example',
  address: process.env.CONTACT_ADDRESS || '123 Sample St.',
  hours: process.env.CONTACT_HOURS || 'Mon-Sat, 10AM-7PM',
};
const ADMIN_PSID = process.env.ADMIN_PSID || '';

/** Fire-and-forget send that never breaks the flow — a failed message is logged only. */
function safeSend(p: Promise<any>): Promise<void> {
  return p.catch((e) => { console.error('[webhook] send failed', e); return undefined; });
}

// ---------- public base URL for image links ----------
// Messenger requires absolute https URLs for images. Resolution order:
//   1. BASE_URL env var (explicit override, e.g. a custom domain)
//   2. The origin of the incoming webhook request itself. Meta always calls the
//      webhook over https, so on Render the Host header IS the public URL —
//      images work with zero extra configuration (no BASE_URL needed).
// A BASE_URL pointing at localhost or an ngrok tunnel is ignored (with a
// warning) — those hosts are unreachable from Messenger and would silently
// break every image.
function envBaseUrl(): string {
  // 1. Explicit BASE_URL env var takes priority (set this in Render Dashboard)
  let raw = (process.env.BASE_URL || '').replace(/\/+$/, '');
  // 2. On Render, fall back to RENDER_EXTERNAL_URL if BASE_URL not set
  if (!raw && process.env.RENDER_EXTERNAL_URL) {
    raw = process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, '');
  }
  if (!raw) return '';
  // Ignore localhost / tunnel hosts — unreachable from Messenger
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(raw) || /(^|\.)ngrok/i.test(raw)) {
    console.warn(`[webhook] ignoring BASE_URL="${raw}" (localhost/tunnel host, unreachable from Messenger) — using the webhook request origin instead`);
    return '';
  }
  return raw;
}
const ENV_BASE_URL = envBaseUrl();
let requestBaseUrl = '';

/** Public URL for the webview ordering page (BASE_URL or request origin + /webview) */
function webviewUrl(): string {
  const base = ENV_BASE_URL || requestBaseUrl;
  return base ? base.replace(/\/+$/, '') + '/webview' : '';
}

/** Capture the public origin from each webhook request (call before handling). */
export function setRequestOrigin(req: any): void {
  try {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || '').split(',')[0].trim();
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    if (host && proto === 'https') requestBaseUrl = `https://${host}`;
  } catch { /* keep last good value */ }
}

/**
 * Encode unsafe characters in the path portion of a URL (space, &, parens,
 * '+', '%', ...). Storage keys like "sweet&sour.jpg" or "chicken fillet.jpg"
 * break URLs otherwise: a raw '&' starts the query string (so appending
 * "?v=..." later would cut the filename in half) and spaces are invalid.
 * Segments that already contain escapes are decoded first to avoid
 * double-encoding. The query string is left untouched.
 */
function encodeUrlPath(url: string): string {
  const qIndex = url.indexOf('?');
  const base = qIndex === -1 ? url : url.slice(0, qIndex);
  const query = qIndex === -1 ? '' : url.slice(qIndex);
  const schemeEnd = base.indexOf('://');
  const pathStart = schemeEnd === -1 ? 0 : base.indexOf('/', schemeEnd + 3);
  const prefix = pathStart === -1 ? base : base.slice(0, pathStart);
  const rawPath = pathStart === -1 ? '' : base.slice(pathStart);
  const encoded = rawPath.split('/').map((seg) => {
    if (!seg) return seg;
    try { seg = decodeURIComponent(seg); } catch { /* raw '%' in name — keep and escape below */ }
    return encodeURIComponent(seg);
  }).join('/');
  return prefix + encoded + query;
}

/** Messenger requires absolute https URLs for images. */
function absUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return encodeUrlPath(url);
  const base = ENV_BASE_URL || requestBaseUrl;
  if (!base) return undefined; // no public URL known -> skip image
  return encodeUrlPath(base + url);
}

/**
 * Messenger caches images by URL, and so does the storage CDN (e.g. Supabase):
 * replacing a file in place keeps the same URL, so the old image keeps showing.
 * Append a fresh cache-buster to remote URLs on every send so updates reflect
 * immediately. Local /uploads files already have unique filenames -> no busting.
 */
function imageUrl(url?: string | null): string | undefined {
  const abs = absUrl(url);
  if (!abs) return abs;
  if (/\/uploads\//.test(abs)) {
    // Local files: strip any stale cache-buster, keep the clean unique URL.
    return abs.split('?')[0];
  }
  if (!/^https?:\/\//i.test(abs)) return abs;
  return `${abs}${abs.includes('?') ? '&' : '?'}v=${Date.now()}`;
}

// ---------- helpers ----------
async function ensureCustomer(psid: string): Promise<any> {
  let c = await getCustomerByPsid(psid);
  if (!c) {
    c = await createCustomer(psid);
  }
  return c;
}

/**
 * Parse a free-text time from the customer and normalize it to the app's
 * canonical 12-hour label (same format as time_slots, e.g. "10:00 AM").
 * Accepts 12-hour input with AM/PM ("2:30 pm", "11 am", "2pm") and 24-hour
 * ("14:30", "9:00") for backwards compatibility.
 */
export function parseTimeInput(raw: string): { ok: boolean; label?: string } {
  const t = raw.trim().toUpperCase().replace(/\./g, '');
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/);
  if (!m) return { ok: false };
  const mm = m[2] ? Number(m[2]) : 0;
  if (mm > 59) return { ok: false };
  let h = Number(m[1]);
  if (m[3]) {
    // 12-hour with AM/PM
    if (h < 1 || h > 12) return { ok: false };
    if (m[3] === 'AM') h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  } else if (h > 23) {
    return { ok: false };
  }
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return { ok: true, label: `${h12}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}` };
}

const MONTH_NAMES: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7,
  sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

/** Look up a month by full name ("september"), 4-letter ("sept") or 3-letter ("sep"). */
function monthFrom(word: string): number | undefined {
  return MONTH_NAMES[word] ?? MONTH_NAMES[word.slice(0, 4)] ?? MONTH_NAMES[word.slice(0, 3)];
}

/**
 * Parse a free-text date from the customer into canonical YYYY-MM-DD.
 * Accepts (case-insensitive):
 *   2026-09-25                    ISO format
 *   09/25   9-25   09.25          month/day (no year → this year, or next if past)
 *   09/25/2026   9-25-26          with year (2- or 4-digit)
 *   Sep 25   September 25 2026    month-name forms, both orders, "25th" ok
 *   today / tomorrow              relative words
 * Day-first input is auto-detected ("25/09" → 25 Sep).
 */
export function parseDateInput(raw: string): { ok: boolean; date?: string } {
  const t = raw.trim().toLowerCase().replace(/\s+/g, ' ').replace(/,/g, '');
  if (!t) return { ok: false };
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const fmt = (d: Date) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const mk = (y: number, mo: number, day: number) => {
    const d = new Date(y, mo, day);
    if (isNaN(d.getTime()) || d.getFullYear() !== y || d.getMonth() !== mo || d.getDate() !== day) return { ok: false };
    return { ok: true, date: fmt(d) };
  };
  const rollYear = (y: number, mo: number, day: number) => {
    const cand = new Date(y, mo, day);
    return cand < today ? y + 1 : y;
  };

  // Relative words
  if (t === 'today' || t === 'ngayon') return mk(now.getFullYear(), now.getMonth(), now.getDate());
  if (t === 'tomorrow' || t === 'bukas') return mk(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  // ISO: YYYY-MM-DD (also 2026/09/25)
  let m = t.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return mk(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  // Numeric with separators: MM/DD, MM/DD/YYYY (auto-swaps if day comes first)
  m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?$/);
  if (m) {
    let mo = Number(m[1]) - 1;
    let day = Number(m[2]);
    let year = m[3] ? Number(m[3]) : now.getFullYear();
    if (m[3] && year < 100) year += 2000;
    if (mo > 11 && day <= 12) { const tmp = mo; mo = day - 1; day = tmp + 1; }
    if (!m[3]) year = rollYear(year, mo, day);
    return mk(year, mo, day);
  }

  // "september 25" / "september 25 2026"
  m = t.match(/^([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/);
  if (m) {
    const mo = monthFrom(m[1]);
    if (mo !== undefined) {
      const day = Number(m[2]);
      let year = m[3] ? Number(m[3]) : now.getFullYear();
      if (!m[3]) year = rollYear(year, mo, day);
      return mk(year, mo, day);
    }
  }

  // "25 september" / "25 sep 2026"
  m = t.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,9})\.?(?: (\d{4}))?$/);
  if (m) {
    const mo = monthFrom(m[2]);
    if (mo !== undefined) {
      const day = Number(m[1]);
      let year = m[3] ? Number(m[3]) : now.getFullYear();
      if (!m[3]) year = rollYear(year, mo, day);
      return mk(year, mo, day);
    }
  }

  return { ok: false };
}

function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today / tomorrow / +3 days / +1 week as quick replies. 'ck' = checkout, 'res' = reservation. */
function dateQuickReplies(kind: 'ck' | 'res'): { title: string; payload: string }[] {
  const now = new Date();
  const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  const prefix = kind === 'ck' ? 'CKDATE' : 'RESDATE';
  return [
    { title: 'Today', payload: `${prefix}:${isoDay(day(0))}` },
    { title: 'Tomorrow', payload: `${prefix}:${isoDay(day(1))}` },
    { title: 'In 3 days', payload: `${prefix}:${isoDay(day(3))}` },
    { title: 'In 1 week', payload: `${prefix}:${isoDay(day(7))}` },
  ];
}

async function askCheckoutDate(psid: string, ctx: any) {
  await setState(psid, 'CHECKOUT_DATE', ctx);
  return sendQuickReplies(psid, '📅 When would you like your order? (pick below, or type any date — e.g. 09/25, Sep 25, tomorrow):', dateQuickReplies('ck'));
}

async function showReservationSlots(psid: string, ctx: any) {
  await setState(psid, 'RESERVE_SLOT', { ...ctx, res_date: ctx.res_date });
  const slots = await slotAvailability(ctx.res_date);
  return sendQuickReplies(psid, `Choose a slot for ${ctx.res_date}:`, [
    ...slots.filter((s: any) => !s.full).map((s: any) => ({ title: `${s.label} (${s.capacity - s.used} left)`.slice(0, 20), payload: `RESSLOT:${s.label}` })),
  ]);
}

async function mainMenu(psid: string) {
  await setState(psid, 'MAIN_MENU');
  // Messenger button templates hold a MAXIMUM of 3 buttons (sendButtons drops
  // anything past the third), so the main menu renders as quick replies — up to
  // 13 can display, guaranteeing all 4 options are visible.
  return sendQuickReplies(psid, '🍽️ Welcome to Postre Food Products!\n\nHow can we help you today?', [
    { title: '🌐 Order Online', payload: 'WEBVIEW' },
    { title: '🎁 Packages', payload: 'MENU_PACKAGES' },
    { title: '📖 View Menu', payload: 'MENU_BROWSE' },
    { title: '🍱 Food Packs', payload: 'MENU_FOODPACKS' },
    { title: '🛒 Order Now', payload: 'MENU_ORDER' },
    { title: '🛒 My Cart', payload: 'MENU_CART' },
    { title: '📍 Track Order', payload: 'TRACK_ORDER' },
    { title: '📅 Reservation', payload: 'MENU_RESERVE' },
    { title: '📜 Order History', payload: 'ORDER_HISTORY' },
    { title: '📞 Contact Us', payload: 'MENU_CONTACT' },
  ]);
}

function money(n: number) { return `\u20b1${n.toLocaleString('en-PH')}`; }

async function showCart(psid: string) {
  const items = await getCart(psid);
  if (items.length === 0) {
    await sendText(psid, '🛒 Your cart is empty.\n\nBrowse our menu to add items!');
    return mainMenu(psid);
  }
  let totals: any;
  try {
    // If the customer already chose a delivery area during checkout, show its fee.
    const stateNow = await getState(psid);
    const fee = (stateNow.ctx?.delivery_type === 'delivery' && stateNow.ctx?.delivery_fee)
      ? stateNow.ctx.delivery_fee
      : 0;
    totals = await cartTotals(psid, fee);
  } catch {
    // A stale item (dish no longer allowed in its slot, changed price, etc.)
    // must not take down the whole cart view — price item by item instead.
    let subtotal = 0, discount = 0, broken = 0;
    const keep: any[] = [];
    for (const it of items) {
      try {
        const t = await computeCartTotals([it], 0);
        subtotal += t.subtotal;
        discount += t.discount;
        keep.push(it);
      } catch { broken++; }
    }
    if (broken > 0) {
      const cartIdNow = await getOrCreateCart(psid);
      const keepIds = keep.map((k) => Number(k.id));
      if (keepIds.length > 0) {
        await supa().from('cart_items').delete().eq('cart_id', cartIdNow).not('id', 'in', `(${keepIds.join(',')})`);
      } else {
        await supa().from('cart_items').delete().eq('cart_id', cartIdNow);
      }
      await sendText(psid, `⚠️ ${broken} item(s) in your cart are no longer available and were removed.`);
    }
    totals = { subtotal, delivery: 0, discount, total: subtotal };
    if (keep.length === 0) {
      await sendText(psid, '🛒 Your cart is empty.\n\nBrowse our menu to add items!');
      return mainMenu(psid);
    }
  }
  const lines = await Promise.all(items.map(async (i: any) => {
    let label = `${i.quantity}x ${i.name}`;
    if (i.package_id && Array.isArray(i.slot_choices) && i.slot_choices.length) {
      const dishes = (await Promise.all(i.slot_choices
        .map(async (c: any) => (await getProductById(c.product_id))?.name)))
        .filter(Boolean).join(', ');
      if (dishes) label += `\n   📦 ${dishes}`;
    }
    let lineTotal = 0;
    try { lineTotal = (await computeCartTotals([i], 0)).subtotal; } catch { lineTotal = 0; }
    return `• ${label} — ${money(lineTotal)}`;
  })).then(l => l.join('\n'));
  await sendText(psid,
    `🛒 YOUR CART\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `${lines}\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `${totals.delivery > 0 ? `📦 Delivery: ${money(totals.delivery)}\n` : ''}` +
    `${totals.discount > 0 ? `🏷️ Discount: -${money(totals.discount)}\n` : ''}` +
    `💰 TOTAL: ${money(totals.total)}`
  );
  return sendQuickReplies(psid, 'What would you like to do?', [
    { title: '✅ Checkout', payload: 'CART_CHECKOUT' },
    { title: '📋 Add More', payload: 'MENU_ORDER' },
    { title: '❌ Remove Item', payload: 'CART_REMOVE' },
    { title: '🔢 Change Qty', payload: 'CART_QTY' },
  ]);
}

// ---------- category icons ----------
// Emojis are written as \u{...} escapes, keeping this file pure ASCII — literal
// non-ASCII bytes previously got mangled by editor encoding changes and sent
// garbage to Messenger (see patch-webhook.cjs / fix-encoding.cjs history, and
// money()'s \u20b1). Matched by keyword so new categories get a sensible icon
// automatically; anything unmatched falls back to cutlery.
const CATEGORY_ICONS: [RegExp, string][] = [
  [/chicken|manok/i, '\u{1F357}'],                                                    // poultry leg
  [/pork|lechon|baboy|ham/i, '\u{1F416}'],                                            // pig
  [/beef|steak|karne/i, '\u{1F969}'],                                                 // cut of meat
  [/seafood|fish|shrimp|crab|scallop|kinilaw|salmon|tilapia/i, '\u{1F990}'],          // shrimp
  [/noodle|pancit|palabok|pasta|carbonara|spaghetti|bam-i|lomi|mami/i, '\u{1F35C}'],  // steaming bowl
  [/vegetable|veggie|chopsuey|salad/i, '\u{1F96C}'],                                  // leafy green
  [/dessert|cake|crepe|sweet|leche|halo|ice/i, '\u{1F370}'],                          // shortcake
  [/rice/i, '\u{1F35A}'],                                                             // cooked rice
  [/drink|beverage|juice|soda|tea|coffee/i, '\u{1F964}'],                             // cup with straw
  [/bilao|platter|combo|package|party/i, '\u{1F958}'],                                // shallow pan of food
];
const DEFAULT_CATEGORY_ICON = '\u{1F374}';                                            // fork and knife

/** Icon shown before a category name in the Messenger category list. */
function categoryIcon(name: string): string {
  for (const [re, icon] of CATEGORY_ICONS) if (re.test(name)) return icon;
  return DEFAULT_CATEGORY_ICON;
}

async function showCategories(psid: string, backPayload = 'MAIN_MENU_BACK') {
  const cats = await getActiveCategories();
  await setState(psid, 'ORDER_CATEGORY', { back: backPayload });
  await sendQuickReplies(psid, 'Choose a category:', [
    ...cats.map((c) => ({ title: `${categoryIcon(c.name)} ${c.name}`, payload: `CAT:${c.id}` })),
    { title: 'Back', payload: backPayload },
  ]);
}

async function showProducts(psid: string, categoryId: number, page = 0) {
  const products = await getProductsByCategory(categoryId);
  if (products.length === 0) {
    return sendText(psid, 'No products in this category yet.').then(() => showCategories(psid));
  }
  const PAGE = 10;
  const pages = Math.ceil(products.length / PAGE);
  const safePage = Math.max(0, Math.min(page, pages - 1));
  const slice = products.slice(safePage * PAGE, safePage * PAGE + PAGE);
  await setState(psid, 'ORDER_PRODUCT', { category_id: categoryId, page: safePage });
  await sendCarousel(psid, await Promise.all(slice.map(async (p: any) => {
    const variants = await getProductVariants(p.id);
    const subtitle = variants.map((v) => `${v.size} ${money(v.price)}`).join(' - ');
    return {
      title: p.name,
      subtitle: `${p.description || ''}\n${subtitle}`.trim(),
      image_url: imageUrl(p.photo_url),
      buttons: [{ title: 'Order', payload: `PROD:${p.id}` }],
    };
  })));
  const replies: any[] = slice.map((p: any) => ({ title: p.name.slice(0, 20), payload: `PROD:${p.id}` }));
  if (safePage + 1 < pages) replies.push({ title: 'More products...', payload: `PRODPG:${categoryId}:${safePage + 1}` });
  if (safePage > 0) replies.push({ title: 'Previous page', payload: `PRODPG:${categoryId}:${safePage - 1}` });
  replies.push({ title: 'Categories', payload: 'MENU_ORDER' });
  return sendQuickReplies(psid, `Page ${safePage + 1} of ${pages}. Or pick from the list:`, replies);
}

async function showVariants(psid: string, productId: number): Promise<SendResult | void> {
  const product = await getProductById(productId);
  if (!product) return sendText(psid, 'Product not found.');
  const variants = await getProductVariants(productId);
  await setState(psid, 'ORDER_VARIANT', { product_id: productId });
  if (variants.length === 1) {
    return handlePayload(psid, `SIZE:${productId}:${variants[0].size}`);
  }
  return sendQuickReplies(psid, `Select a size for ${product.name}:`, [
    ...variants.map((v) => ({ title: `${v.size} ${money(v.price)}`.slice(0, 20), payload: `SIZE:${productId}:${v.size}` })),
    { title: 'Back', payload: `CAT:${product.category_id}` },
  ]);
}

async function showQuantity(psid: string, productId: number, size: string) {
  await setState(psid, 'ORDER_QUANTITY', { product_id: productId, size });
  const v = await getVariantByProductAndSize(productId, size);
  return sendQuickReplies(psid, `How many (${size} - ${money(v.price)})?`, [
    { title: '1', payload: `QTY:${productId}:${size}:1` },
    { title: '2', payload: `QTY:${productId}:${size}:2` },
    { title: '3', payload: `QTY:${productId}:${size}:3` },
    { title: '5', payload: `QTY:${productId}:${size}:5` },
  ]);
}

// ---------- food packs ----------
async function showFoodPacks(psid: string) {
  const packs = await getFoodPacks();
  await setState(psid, 'FOODPACK_LIST');
  if (packs.length === 0) return sendText(psid, 'No food packs available right now.');
  const elements = packs.map((fp: any) => ({
    title: fp.name,
    subtitle: `${money(fp.price)}${fp.serves ? ` — ${fp.serves}` : ''}${fp.description ? `\n${fp.description}` : ''}`,
    image_url: imageUrl(fp.photo_url),
    buttons: [{ title: 'Add to Cart', payload: `FPADD:${fp.id}:1` }],
  }));
  await sendCarousel(psid, elements);
  return sendQuickReplies(psid, 'Or add a pack directly:', [
    ...packs.slice(0, 9).map((fp: any) => ({ title: fp.name.slice(0, 20), payload: `FPQTY:${fp.id}` })),
    { title: 'Main Menu', payload: 'MAIN_MENU_BACK' },
  ]);
}

async function showFoodPackQuantity(psid: string, foodPackId: number) {
  const fp = await getFoodPackById(foodPackId);
  if (!fp) return sendText(psid, 'Food pack not found.');
  await setState(psid, 'FOODPACK_QTY', { food_pack_id: foodPackId });
  return sendQuickReplies(psid, `How many ${fp.name} (${money(fp.price)} each)?`, [
    { title: '1', payload: `FPADD:${foodPackId}:1` },
    { title: '2', payload: `FPADD:${foodPackId}:2` },
    { title: '3', payload: `FPADD:${foodPackId}:3` },
    { title: '5', payload: `FPADD:${foodPackId}:5` },
  ]);
}

async function addFoodPackToCart(psid: string, foodPackId: number, qty: number) {
  const fp = await getFoodPackById(foodPackId);
  if (!fp) return sendText(psid, 'Food pack not found.');
  const quantity = Math.max(1, qty || 1);
  await addItem(psid, { food_pack_id: foodPackId, quantity });
  return sendText(psid, `✅ Added ${quantity}x ${fp.name} (food pack) to your cart!\nPrice: ${money(fp.price * quantity)}`)
    .then(() => sendButtons(psid, 'What next?', [
      { title: '🛒 View Cart', payload: 'MENU_CART' },
      { title: '💳 Checkout', payload: 'CART_CHECKOUT' },
      { title: '🍱 Food Packs', payload: 'MENU_FOODPACKS' },
    ]));
}

// ---------- packages ----------
async function getPackage(packageId: number) {
  return await getPackageById(packageId);
}

async function showPackages(psid: string) {
  const packages = await getPackages();
  await setState(psid, 'PACKAGE_LIST');
  if (packages.length === 0) return sendText(psid, 'No packages available right now.');
  const elements = packages.map((p: any) => p.is_custom ? {
    title: p.name,
    subtitle: `${money(p.base_price)} base — Pick any ${p.selections} dishes you like`,
    image_url: imageUrl(p.photo_url),
    buttons: [{ title: 'Start Building', payload: `PKG:${p.id}` }],
  } : {
    title: p.name,
    subtitle: `${money(netPackagePrice(p))}${p.discount > 0 ? ` — Save ${money(p.discount)}` : ''} — ${p.is_fixed ? `Fixed: ${p.selections} dishes, ready to order` : `Choose ${p.selections} dishes`}`,
    image_url: imageUrl(p.photo_url),
    buttons: [{ title: 'View Package', payload: `PKG:${p.id}` }],
  });
  return sendCarousel(psid, elements);
}

async function packageLines(packageId: number, choices: Record<number, number>): Promise<string> {
  const slots = await getPackageSlots(packageId);
  return (await Promise.all(slots.map(async (s: any) => {
    const pid = choices?.[s.slot_number];
    const prod = pid ? await getProductById(pid) : null;
    return `${s.slot_number}. ${prod ? prod.name : '(not chosen yet)'}`;
  }))).join('\n');
}

/** Authoritative total for a complete set of choices, or null when incomplete/invalid. */
async function packageTotal(packageId: number, choices: Record<number, number>, size: string): Promise<number | null> {
  const pkg = await getPackage(packageId);
  if (!pkg) return null;
  const arr = Object.entries(choices || {}).map(([k, v]) => ({ slot_number: Number(k), product_id: Number(v) }));
  if (arr.length !== pkg.selections) return null;
  try {
    return (await pricePackage(packageId, arr, size)).total;
  } catch {
    return null;
  }
}

async function showPackageDetails(psid: string, packageId: number, ctx?: any) {
  const pkg = await getPackage(packageId);
  if (!pkg) return sendText(psid, 'Package not found.');
  const prev = ctx || (await getState(psid)).ctx;
  const saved: Record<number, number> = {};
  if (prev && prev.package_id === packageId && prev.choices) {
    for (const [k, v] of Object.entries(prev.choices)) saved[Number(k)] = Number(v);
  }
  const defaults: Record<number, number> = {};
  for (const d of await packageDefaults(packageId)) defaults[d.slot_number] = d.product_id;
  const choices: Record<number, number> = pkg.is_custom ? { ...saved } : { ...defaults, ...saved };
  await setState(psid, 'PACKAGE_DETAILS', { package_id: packageId, choices });

  // Fixed packages stay on the quick "Add M/L" view unless the user asked to customize.
  if (pkg.is_fixed && !(prev && prev.customize)) {
    const mTotal = (await packageTotal(packageId, choices, 'M')) ?? netPackagePrice(pkg);
    const lTotal = (await packageTotal(packageId, choices, 'L')) ?? netPackagePrice(pkg);
    const saveNote = pkg.discount > 0 ? ` (was ${money(pkg.base_price)} — Save ${money(pkg.discount)})` : '';
    return sendText(psid, `${pkg.name}\n${money(mTotal)}${saveNote}\n\n${await packageLines(packageId, choices)}`)
      .then(() => sendQuickReplies(psid, 'This package is ready to order:', [
        { title: `Add M ${money(mTotal)}`.slice(0, 20), payload: `PKGADD:${packageId}:M:1` },
        { title: `Add L ${money(lTotal)}`.slice(0, 20), payload: `PKGADD:${packageId}:L:1` },
        { title: 'Customize', payload: `PKGCUST:${packageId}` },
        { title: 'Packages', payload: 'MENU_PACKAGES' },
      ]));
  }

  const slots = await getPackageSlots(packageId);
  const filled = Object.keys(choices).length;
  const header = pkg.is_custom
    ? `${pkg.name}\n${money(pkg.base_price)} base\n\nPick any ${pkg.selections} dishes (${filled}/${pkg.selections} chosen):\n\n${await packageLines(packageId, choices)}`
    : `${pkg.name}\n${money(netPackagePrice(pkg))}${pkg.discount > 0 ? ` — Save ${money(pkg.discount)}` : ''}\n\n${await packageLines(packageId, choices)}`;
  const verb = pkg.is_custom ? 'Pick' : 'Change';
  const replies: { title: string; payload: string }[] = slots.slice(0, 11).map((s: any) => ({
    title: `${verb} #${s.slot_number}`.slice(0, 20),
    payload: `SLOT:${packageId}:${s.slot_number}`,
  }));
  if (!pkg.is_custom || filled >= pkg.selections) {
    replies.push({ title: 'Size & Add', payload: `PKGSIZE:${packageId}` });
  }
  return sendText(psid, header)
    .then(() => sendQuickReplies(psid, pkg.is_custom ? 'Build your package:' : 'Customize your package:', replies));
}

async function showSlotOptions(psid: string, packageId: number, slotNumber: number, page = 0) {
  const st = await getState(psid);
  const pkg = await getPackage(packageId);
  if (!pkg) return sendText(psid, 'Package not found.');
  const slot = await getPackageSlotByNumber(packageId, slotNumber);
  if (!slot) return sendText(psid, 'Invalid slot.');

  let opts: { product_id: number; product_name: string; upgrade_price: number }[];
  if (pkg.is_custom) {
    // Custom package: every active menu dish is allowed (admin-defined upgrade prices still apply).
    opts = await getCustomSlotOptions(packageId);
  } else {
    opts = await getSlotOptions(slot.id);
  }
  if (opts.length === 0) return sendText(psid, 'No dishes available for this slot right now.');

  const PAGE = 10;
  const pages = Math.ceil(opts.length / PAGE);
  const safePage = Math.max(0, Math.min(page, pages - 1));
  const ctx = st.ctx.package_id === packageId ? st.ctx : { package_id: packageId, choices: {} };
  await setState(psid, 'SELECT_OPTION', { ...ctx, slot_number: slotNumber });
  const replies = opts.slice(safePage * PAGE, safePage * PAGE + PAGE).map((o) => ({
    title: `${o.product_name}${o.upgrade_price > 0 ? ` +${money(o.upgrade_price)}` : ''}`.slice(0, 20),
    payload: `CHOICE:${packageId}:${slotNumber}:${o.product_id}`,
  }));
  if (safePage + 1 < pages) replies.push({ title: 'More options...', payload: `SLOTPG:${packageId}:${slotNumber}:${safePage + 1}` });
  if (safePage > 0) replies.push({ title: 'Previous page', payload: `SLOTPG:${packageId}:${slotNumber}:${safePage - 1}` });
  return sendQuickReplies(psid, `Choose dish for slot #${slotNumber}:`, replies);
}

async function afterChoice(psid: string, packageId: number, slotNumber: number, productId: number) {
  const pkg = await getPackage(packageId);
  if (!pkg) return sendText(psid, 'Package not found.');
  // Validate the dish is allowed in this slot (stale quick replies can reference
  // dishes that were removed or moved) — otherwise the cart becomes unpriceable.
  if (!pkg.is_custom) {
    const slot = await getPackageSlotByNumber(packageId, slotNumber);
    const opt = slot ? await getPackageOptionBySlotAndProduct(slot.id, productId) : null;
    if (!opt) {
      await sendText(psid, 'That dish is no longer available for this slot. Please pick again.');
      return showSlotOptions(psid, packageId, slotNumber);
    }
  } else {
    const prod = await getProductById(productId);
    if (!prod || prod.active !== 1) {
      await sendText(psid, 'That dish is no longer available. Please pick again.');
      return showSlotOptions(psid, packageId, slotNumber);
    }
  }
  const st = await getState(psid);
  const base = st.ctx && st.ctx.package_id === packageId ? st.ctx : { package_id: packageId, choices: {} };
  const ctx = { ...base, choices: { ...(base.choices || {}), [slotNumber]: productId } };
  return showPackageDetails(psid, packageId, ctx);
}

async function showPackageSize(psid: string, packageId: number, ctx?: any) {
  const c = ctx || (await getState(psid)).ctx;
  const choices: Record<number, number> = {};
  if (c && c.choices) for (const [k, v] of Object.entries(c.choices)) choices[Number(k)] = Number(v);
  await setState(psid, 'PACKAGE_SIZE', { package_id: packageId, choices });
  const pkg = await getPackage(packageId);
  const m = await packageTotal(packageId, choices, 'M');
  const l = await packageTotal(packageId, choices, 'L');
  const priceLine = m != null ? `\n\nTotal M: ${money(m)} | Total L: ${money(l ?? (pkg ? netPackagePrice(pkg) : 0))}` : '';
  return sendQuickReplies(psid, `Package dish size? (L may add an upgrade fee)${priceLine}`, [
    { title: 'M - Included', payload: `PKGADD:${packageId}:M:1` },
    { title: 'L + Upgrade', payload: `PKGADD:${packageId}:L:1` },
    { title: 'Back to Menu', payload: 'MAIN_MENU_BACK' },
  ]);
}

async function checkoutStart(psid: string) {
  const items = await getCart(psid);
  if (items.length === 0) return sendText(psid, '🛒 Your cart is empty.\n\nBrowse our menu to add items!');
  await setState(psid, 'CHECKOUT_TYPE');
  return sendQuickReplies(psid, '🚚 How would you like to receive your order?', [
    { title: '🚚 Delivery', payload: 'TYPE:delivery' },
    { title: '🏪 Pickup', payload: 'TYPE:pickup' },
  ]);
}

async function addPackageToCart(psid: string, packageId: number, size: string, qty: number) {
  const pkg = await getPackage(packageId);
  if (!pkg) return sendText(psid, 'Package not found.');
  const chosenSize = size.toUpperCase() === 'L' ? 'L' : 'M';
  const st = (await getState(psid)).ctx;
  const choices: Record<number, number> = {};
  if (st && st.package_id === packageId && st.choices) {
    for (const [k, v] of Object.entries(st.choices)) choices[Number(k)] = Number(v);
  }
  if (Object.keys(choices).length === 0) {
    for (const d of await packageDefaults(packageId)) choices[d.slot_number] = d.product_id;
  }
  if (Object.keys(choices).length !== pkg.selections) {
    return showPackageDetails(psid, packageId, { package_id: packageId, choices });
  }
  const arr = Object.entries(choices).map(([k, v]) => ({ slot_number: Number(k), product_id: Number(v) }));
  let total = netPackagePrice(pkg);
  try { total = (await pricePackage(packageId, arr, chosenSize)).total; } catch { /* fall back to base price */ }
  await addItem(psid, { package_id: packageId, variant_size: chosenSize, quantity: qty, slot_choices: arr });
  return sendText(psid, `Added ${qty}x ${pkg.name} (${chosenSize}) to your cart.\n\n${await packageLines(packageId, choices)}\nPrice: ${money(total)}`)
    .then(() => sendButtons(psid, 'What next?', [
      { title: 'View Cart', payload: 'MENU_CART' },
      { title: 'Checkout', payload: 'CART_CHECKOUT' },
      { title: 'Keep Shopping', payload: 'MENU_ORDER' },
    ]));
}

async function handlePayload(psid: string, payload: string): Promise<SendResult | void> {
  const [cmd, ...rest] = payload.split(':');
  switch (cmd) {
    case 'GET_STARTED':
    case 'MAIN_MENU':
    case 'MAIN_MENU_BACK':
      return mainMenu(psid);
    case 'WEBVIEW': {
      const url = webviewUrl();
      if (url) {
        // Pass the PSID so the webview can identify the customer and link orders to their Messenger account.
        const webviewLink = url + (url.includes('?') ? '&' : '?') + 'psid=' + encodeURIComponent(psid);
        return sendUrlButton(psid, '🌐 Order online through our web store!\n\nTap the button below to open the web ordering page inside Messenger:', '🌐 Open Web Store', webviewLink);
      }
      return sendText(psid, '🌐 Web ordering is coming soon! For now, please use the menu below to order.');
    }
    case 'MENU_ORDER':
      return showCategories(psid);
    case 'MENU_PACKAGES':
      return showPackages(psid);
    case 'MENU_BROWSE': {
      const cats = await getActiveCategories();
      await setState(psid, 'BROWSE_CATEGORY');
      return sendQuickReplies(psid, 'Browse our menu:', [
        ...cats.map((c) => ({ title: `${categoryIcon(c.name)} ${c.name}`, payload: `BROWSE:${c.id}` })),
        { title: 'Back', payload: 'MAIN_MENU_BACK' },
      ]);
    }
    case 'BROWSE':
      return showProducts(psid, Number(rest[0]));
    case 'CAT':
      return showProducts(psid, Number(rest[0]));
    case 'PRODPG':
      return showProducts(psid, Number(rest[0]), Number(rest[1] || 0));
    case 'CKDATE': {
      const d = rest[0];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return sendText(psid, 'Invalid date. Please try again.');
      const dateOpen = await isDateOpen(d);
      if (!dateOpen.open) {
        return sendText(psid, `We are closed on ${d}. Please pick another date.`)
          .then(async () => askCheckoutDate(psid, (await getState(psid)).ctx));
      }
            await setState(psid, 'CHECKOUT_TIME', { ...(await getState(psid)).ctx, fulfillment_date: d });
      return sendText(psid, `✅ Date set: ${d}\n⏰ What time? (e.g. 2:30 PM or 14:30)`);
    }
    case 'RESDATE': {
      const d = rest[0];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return sendText(psid, 'Invalid date. Please try again.');
      const dateOpen = await isDateOpen(d);
      if (!dateOpen.open) {
        return sendText(psid, `We are closed on ${d}. Please pick another date.`).then(() =>
          sendQuickReplies(psid, 'Pick a date:', dateQuickReplies('res')));
      }
      return showReservationSlots(psid, { ...(await getState(psid)).ctx, res_date: d });
    }
    case 'PROD':
      return showVariants(psid, Number(rest[0]));
    case 'SIZE': {
      const productId = Number(rest[0]);
      const size = rest[1];
      return showQuantity(psid, productId, size);
    }
    case 'QTY': {
      const productId = Number(rest[0]);
      const size = rest[1];
      const qty = Number(rest[2]);
      const product = await getProductById(productId);
      const v = await getVariantByProductAndSize(productId, size);
      await addItem(psid, { product_id: productId, variant_size: size, quantity: qty });
      sendText(psid, `✅ Added ${qty}x ${product.name} (${size}) to your cart!`)
        .then(() => sendButtons(psid, 'What next?', [
          { title: '🛒 View Cart', payload: 'MENU_CART' },
          { title: '💳 Checkout', payload: 'CART_CHECKOUT' },
          { title: '📋 Keep Shopping', payload: 'MENU_ORDER' },
        ]));
      return;
    }
    case 'MENU_CART':
      return showCart(psid);
    case 'CART_REMOVE': {
      const items = await getCart(psid);
      if (items.length === 0) return sendText(psid, 'Your cart is empty.');
      await setState(psid, 'CART_REMOVE_ITEM');
      return sendQuickReplies(psid, 'Remove which item?', [
        ...items.slice(0, 10).map((i: any) => ({ title: `${i.name}`.slice(0, 20), payload: `REMOVE:${i.id}` })),
        { title: 'Cancel', payload: 'MENU_CART' },
      ]);
    }
    case 'REMOVE': {
      const lineId = Number(rest[0]);
      await removeItem(psid, lineId);
      return showCart(psid);
    }
    case 'CART_QTY': {
      const items = await getCart(psid);
      if (items.length === 0) return sendText(psid, 'Your cart is empty.');
      await setState(psid, 'CART_QTY_SELECT');
      return sendQuickReplies(psid, 'Change quantity for which item?', [
        ...items.slice(0, 10).map((i: any) => ({ title: `${i.name}`.slice(0, 20), payload: `QTYCHG:${i.id}` })),
        { title: 'Cancel', payload: 'MENU_CART' },
      ]);
    }
    case 'QTYCHG': {
      const itemId = Number(rest[0]);
      const item = (await getCart(psid)).find((i: any) => i.id === itemId);
      if (!item) return showCart(psid);
      await setState(psid, 'CART_QTY_SET', { item_id: itemId });
      return sendQuickReplies(psid, `${item.name} — current qty ${item.quantity}. New quantity?`, [
        { title: '1', payload: `QTYCHGSET:${itemId}:1` },
        { title: '2', payload: `QTYCHGSET:${itemId}:2` },
        { title: '3', payload: `QTYCHGSET:${itemId}:3` },
        { title: '5', payload: `QTYCHGSET:${itemId}:5` },
        { title: 'Cancel', payload: 'MENU_CART' },
      ]);
    }
    case 'QTYCHGSET': {
      const itemId = Number(rest[0]);
      const qty = Number(rest[1]);
      if (!Number.isFinite(qty) || qty <= 0) return showCart(psid);
      await updateQuantity(psid, itemId, qty);
      return showCart(psid);
    }
    case 'CART_CHECKOUT':
      return checkoutStart(psid);
    case 'TYPE': {
      const type = rest[0];
      // No delivery fee is charged here — the admin sets the actual fare when
      // confirming the order, so the customer just provides the address.
      await setState(psid, 'CHECKOUT_ADDRESS', { delivery_type: type });
      if (type === 'pickup') return handlePayload(psid, 'ASK_PHONE');
      return sendText(psid, 'Please type your delivery address (house #, street, barangay, city):');
    }
    case 'ASK_PHONE':
      await setState(psid, 'CHECKOUT_PHONE', (await getState(psid)).ctx);
      return sendText(psid, 'Please type your contact number:');
    case 'ASK_NOTES':
      // Special-notes step removed from the checkout flow — go straight to payment.
      return handlePayload(psid, 'ASK_PAY');
    case 'ASK_PAY':
      await setState(psid, 'CHECKOUT_PAY', (await getState(psid)).ctx);
      return sendQuickReplies(psid, 'Payment method:', [
        { title: 'COD', payload: 'PAY:cod' },
        { title: 'GCash', payload: 'PAY:gcash' },
        { title: 'Bank Transfer', payload: 'PAY:bank' },
      ]);
    case 'PAY': {
      const method = rest[0];
      const st = await getState(psid);
      try {
        const cust = await getCustomerByPsid(psid);
        if (!cust) throw new Error('Customer not found');
        // Remember contact details collected during checkout on the customer record.
        if (st.ctx.phone || st.ctx.address) {
          const upd: Record<string, any> = {};
          if (st.ctx.phone) upd.phone = st.ctx.phone;
          if (st.ctx.address) upd.address = st.ctx.address;
          await supa().from('customers').update(upd).eq('id', cust.id);
        }
        const order = await createOrderFromCart(psid, {
          customer_id: cust.id,
          order_type: st.ctx.delivery_type || 'delivery',
          address: st.ctx.address,
          phone: st.ctx.phone,
          fulfillment_date: st.ctx.fulfillment_date,
          time_slot: st.ctx.time_slot,
          notes: st.ctx.notes,
          payment_method: method,
        });
        await setState(psid, 'ORDER_CONFIRMED', { order_id: order.orderId });
        const payInfo = PAYMENT_INFO[method as 'cod'] || '';
        // Get order items for detailed confirmation
        const orderItems = await getOrderItems(order.orderId);
        await sendOrderConfirmation(psid, { ...order, order_number: order.orderNumber }, orderItems);
        await sendText(psid, payInfo);
        // Notify the owner about the new order (optional ADMIN_PSID in .env).
        if (ADMIN_PSID) {
          safeSend(sendText(ADMIN_PSID,
            `🆕 New order ${order.orderNumber} (${method.toUpperCase()})\n` +
            `${st.ctx.delivery_type || 'delivery'}${st.ctx.address ? '\n📍 ' + st.ctx.address : ''}\n` +
            `💰 Total: ${money(order.total)}`));
        }
        // Web push notification to all registered admin browsers.
        safeSend(sendPushToAdmins({
          title: `🆕 New Order ${order.orderNumber}`,
          body: `${st.ctx.delivery_type || 'delivery'}${st.ctx.address ? ' • ' + st.ctx.address : ''}\n💰 Total: ${money(order.total)}`,
        }));
        return mainMenu(psid);
      } catch (e: any) {
        safeSend(sendText(psid, 'Sorry, something went wrong placing your order. Please try again.').then(() => mainMenu(psid)));
      }
      return;
    }
    case 'TRACK_ORDER': {
      const cust = await getCustomerByPsid(psid);
      const recent = cust ? await getCustomerOrders(cust.id, 5) : [];
      if (recent.length > 0) {
        await setState(psid, 'TRACK_ORDER_INPUT');
        return sendQuickReplies(psid, 'Track which order? (or type the number, e.g. PP-1001):', [
          ...recent.map((o: any) => ({ title: `${o.order_number}`.slice(0, 20), payload: `TRACKNUM:${o.order_number}` })),
          { title: '⌨️ Type number', payload: 'TRACK_MANUAL' },
        ]);
      }
      await setState(psid, 'TRACK_ORDER_INPUT');
      return sendText(psid, 'Please enter your order number (e.g., PP-1001):');
    }
    case 'TRACK_MANUAL':
      await setState(psid, 'TRACK_ORDER_INPUT');
      return sendText(psid, 'Please enter your order number (e.g., PP-1001):');
    case 'TRACKNUM': {
      const orderNumber = rest[0];
      const cust = await getCustomerByPsid(psid);
      if (!cust) return sendText(psid, 'Customer not found.');
      const { data: order } = await supa().from('orders').select('*').eq('order_number', orderNumber).eq('customer_id', cust.id).maybeSingle();
      if (!order) return sendText(psid, 'Order not found. Please check the number and try again.');
      const statusHistory = await getOrderStatusHistory(order.id);
      await sendOrderStatus(psid, order, statusHistory);
      if (order.status === 'READY') {
        // Customer can complete the order themselves once it is delivered/ready.
        return sendQuickReplies(psid, 'Did you receive your order?', [
          { title: '✅ Order Received', payload: `COMPLETE:${order.id}` },
          { title: '🏠 Main Menu', payload: 'MAIN_MENU_BACK' },
        ]);
      }
      return mainMenu(psid);
    }
    case 'ORDER_HISTORY': {
      const cust = await getCustomerByPsid(psid);
      if (!cust) return sendText(psid, 'No customer record found.');
      const orders = await getCustomerOrders(cust.id, 5);
      await sendOrderHistory(psid, orders);
      return;
    }
    case 'PKG':
      return showPackageDetails(psid, Number(rest[0]));
    case 'SLOT':
      return showSlotOptions(psid, Number(rest[0]), Number(rest[1]));
    case 'PKGCUST':
      return showPackageDetails(psid, Number(rest[0]), { package_id: Number(rest[0]), customize: true, choices: {} });
    case 'SLOTPG':
      return showSlotOptions(psid, Number(rest[0]), Number(rest[1]), Number(rest[2] || 0));
    case 'CHOICE':
      return afterChoice(psid, Number(rest[0]), Number(rest[1]), Number(rest[2]));
    case 'PKGSIZE':
      return showPackageSize(psid, Number(rest[0]));
    case 'PKGADD':
      return addPackageToCart(psid, Number(rest[0]), rest[1], Number(rest[2]));
    case 'MENU_FOODPACKS':
      return showFoodPacks(psid);
    case 'FPQTY':
      return showFoodPackQuantity(psid, Number(rest[0]));
    case 'FPADD':
      return addFoodPackToCart(psid, Number(rest[0]), Number(rest[1]));
    case 'MENU_RESERVE':
      await setState(psid, 'RESERVE_TYPE');
      return sendQuickReplies(psid, 'Reservation for?', [
        { title: 'Cottage', payload: 'RESTYPE:Cottage' },
        { title: 'Table', payload: 'RESTYPE:Table' },
      ]);
    case 'RESTYPE': {
      const type = rest[0];
      await setState(psid, 'RESERVE_DATE', { res_type: type });
      return sendQuickReplies(psid, 'What date? (tap below, or type any date — e.g. Sep 25, 09/25, tomorrow):', dateQuickReplies('res'));
    }
    case 'REORDER_CONFIRM':
      return reorderPreviousOrder(psid, Number(rest[0]));
    case 'RES_PHONE_ASK': {
      await setState(psid, 'RESERVE_PHONE', (await getState(psid)).ctx);
      return sendText(psid, 'Contact number for the reservation?');
    }
    case 'MENU_CONTACT':
      setState(psid, 'CONTACT_MENU');
      return sendText(psid,
        '📞 CONTACT US\n' +
        '━━━━━━━━━━━━━━━━━━━\n' +
        `📱 Phone: ${CONTACT_INFO.phone}\n` +
        `📧 Email: ${CONTACT_INFO.email}\n` +
        `📍 Address: ${CONTACT_INFO.address}\n` +
        '━━━━━━━━━━━━━━━━━━━\n' +
        `⏰ Open: ${CONTACT_INFO.hours}`
      ).then(() => mainMenu(psid));
    default:
      return mainMenu(psid);
  }
}

async function handleText(psid: string, text: string) {
  const st = await getState(psid);
  const state = st.state;
  const ctx = st.ctx || {};

  switch (state) {
    case 'CHECKOUT_ADDRESS':
      await setState(psid, 'CHECKOUT_ADDRESS_DONE', { ...ctx, address: text });
      return handlePayload(psid, 'ASK_PHONE');
    case 'CHECKOUT_PHONE':
      if (!/^[0-9+\-\s()]{7,15}$/.test(text.trim())) {
        return sendText(psid, 'That does not look like a valid phone number. Please try again:');
      }
      return askCheckoutDate(psid, { ...ctx, phone: text.trim() });
    case 'CHECKOUT_DATE': {
      const parsed = parseDateInput(text);
      if (!parsed.ok || !parsed.date) {
        return sendText(psid, 'Please enter a valid date — e.g. 2026-09-25, 09/25, Sep 25, or "tomorrow":').then(() => askCheckoutDate(psid, ctx));
      }
      if (parsed.date < isoDay(new Date())) {
        return sendText(psid, 'That date is in the past. Please pick today or a later date.').then(() => askCheckoutDate(psid, ctx));
      }
      const dateOpen = await isDateOpen(parsed.date);
      if (!dateOpen.open) {
        return sendText(psid, `We are closed on ${parsed.date}. Please pick another date.`).then(() => askCheckoutDate(psid, ctx));
      }
      await setState(psid, 'CHECKOUT_TIME', { ...ctx, fulfillment_date: parsed.date });
      return sendText(psid, `✅ Date set: ${parsed.date}\n⏰ What time? (e.g. 2:30 PM or 14:30)`);
    }
    case 'CHECKOUT_TIME': {
      const parsed = parseTimeInput(text);
      if (!parsed.ok) {
        return sendText(psid, 'Please enter a valid time, e.g. 2:30 PM or 14:30:');
      }
      await setState(psid, 'CHECKOUT_TIME_DONE', { ...ctx, time_slot: parsed.label! });
      return handlePayload(psid, 'ASK_PAY');
    }
    case 'CHECKOUT_NOTES':
      await setState(psid, 'CHECKOUT_NOTES_DONE', { ...ctx, notes: text.trim().toLowerCase() === 'none' ? '' : text.trim() });
      return handlePayload(psid, 'ASK_PAY');
    case 'TRACK_ORDER_INPUT': {
      // Handle order tracking by order number
      const orderNumber = text.trim().toUpperCase();
      if (!orderNumber.startsWith('PP-')) {
        return sendText(psid, 'Please enter a valid order number (e.g., PP-1001):');
      }
      const cust = await getCustomerByPsid(psid);
      if (!cust) return sendText(psid, 'Customer not found.');
      const { data: order } = await supa().from('orders').select('*').eq('order_number', orderNumber).eq('customer_id', cust.id).maybeSingle();
      if (!order) return sendText(psid, 'Order not found. Please check the number and try again.');
      const statusHistory = await getOrderStatusHistory(order.id);
      await sendOrderStatus(psid, order, statusHistory);
      if (order.status === 'READY') {
        // Customer can complete the order themselves once it is delivered/ready.
        return sendQuickReplies(psid, 'Did you receive your order?', [
          { title: '✅ Order Received', payload: `COMPLETE:${order.id}` },
          { title: '🏠 Main Menu', payload: 'MAIN_MENU_BACK' },
        ]);
      }
      return mainMenu(psid);
    }
    case 'RESERVE_DATE': {
      const parsed = parseDateInput(text);
      if (!parsed.ok || !parsed.date) {
        return sendText(psid, 'Please enter a valid date — e.g. 2026-09-25, 09/25, Sep 25, or "tomorrow":').then(() =>
          sendQuickReplies(psid, 'Pick a date:', dateQuickReplies('res')));
      }
      if (parsed.date < isoDay(new Date())) {
        return sendText(psid, 'That date is in the past. Please pick another date:').then(() =>
          sendQuickReplies(psid, 'Pick a date:', dateQuickReplies('res')));
      }
      const dateOpen = await isDateOpen(parsed.date);
      if (!dateOpen.open) {
        return sendText(psid, 'We are closed on that day. Please pick another date:').then(() =>
          sendQuickReplies(psid, 'Pick a date:', dateQuickReplies('res')));
      }
      // Slots ARE the time — no redundant free-text time step.
      return showReservationSlots(psid, { ...ctx, res_date: parsed.date });
    }
    case 'RESERVE_NAME':
      await setState(psid, 'RESERVE_NAME_DONE', { ...ctx, res_name: text.trim() });
      return handlePayload(psid, 'RES_PHONE_ASK');
    case 'RESERVE_PHONE': {
      // Fixes the dead-end: typed phone numbers were ignored because this state
      // had no text handler, so reservations could never be completed.
      if (!/^[0-9+\-\s()]{7,15}$/.test(text.trim())) {
        return sendText(psid, 'That does not look like a valid phone number. Please try again:');
      }
      try {
        const res = await createReservation({ customer_name: ctx.res_name, phone: text.trim(), res_date: ctx.res_date, time_slot: ctx.res_time, notes: ctx.res_type });
        await setState(psid, 'RESERVE_CONFIRMED', { res_id: res });
        await sendText(psid, `Reservation confirmed! Reference: RES-${res}\n${ctx.res_type} on ${ctx.res_date} at ${ctx.res_time}.`);
        return mainMenu(psid);
      } catch (e: any) {
        await sendText(psid, 'Could not complete the reservation. Please try again.');
        return mainMenu(psid);
      }
    }
    default:
      // unknown text -> main menu
      if (text.toLowerCase().includes('menu') || text.toLowerCase().startsWith('hi')) return mainMenu(psid);
      return sendText(psid, 'Sorry, I did not understand that.').then(() => mainMenu(psid));
  }
}

/** Rebuild the cart from a previous order (used by Reorder + after confirmation). */
async function reorderPreviousOrder(psid: string, orderId: number): Promise<void> {
  const cust = await getCustomerByPsid(psid);
  if (!cust) { await sendText(psid, 'Customer not found.'); return; }
  const order = await getOrderById(orderId);
  if (!order || order.customer_id !== cust.id) { await sendText(psid, 'Order not found.'); return; }
  const items = await getOrderItems(orderId);
  await clearCart(psid);
  for (const item of items) {
    if (item.package_id) {
      // Rebuild slot choices from the stored order items; fall back to the
      // package defaults for any slot whose dish can no longer be resolved.
      const pkgChoices: Record<number, number> = {};
      for (const p of item.package_items?.filter(Boolean) || []) {
        if (p.product_id) pkgChoices[Number(p.slot_number)] = Number(p.product_id);
      }
      if (Object.keys(pkgChoices).length !== Number(item.selections ?? 0) && !Object.keys(pkgChoices).length) {
        for (const d of await packageDefaults(item.package_id)) pkgChoices[d.slot_number] = d.product_id;
      }
      const arr = Object.entries(pkgChoices).map(([k, v]) => ({ slot_number: Number(k), product_id: Number(v) }));
      try {
        await pricePackage(item.package_id, arr, item.variant_size);
      } catch {
        await sendText(psid, `⚠️ ${item.name} from your previous order is no longer available as-is — it was skipped. You can customize it again from Packages.`);
        continue;
      }
      await addItem(psid, {
        package_id: item.package_id,
        variant_size: item.variant_size,
        quantity: item.quantity,
        slot_choices: arr,
      });
    } else if (item.food_pack_id) {
      await addItem(psid, {
        food_pack_id: item.food_pack_id,
        quantity: item.quantity,
      });
    } else {
      await addItem(psid, {
        product_id: item.product_id,
        variant_size: item.variant_size,
        quantity: item.quantity,
      });
    }
  }
  await sendText(psid, 'Items from your previous order have been added to your cart!');
  await showCart(psid);
}

export async function handleMessage(messaging: any) {
  const psid = messaging.sender?.id;
  if (!psid) return;
  await ensureCustomer(psid);

  if (messaging.postback?.payload) {
    const payload = messaging.postback.payload;
    if (payload.startsWith('RESSLOT:')) {
      const timeSlot = payload.slice('RESSLOT:'.length);
      const st = await getState(psid);
      await setState(psid, 'RESERVE_NAME', { ...st.ctx, res_time: timeSlot });
      await sendText(psid, 'Name for the reservation?');
      return;
    }
    if (payload === 'RES_PHONE_ASK') {
      await setState(psid, 'RESERVE_PHONE', (await getState(psid)).ctx);
      await sendText(psid, 'Contact number for the reservation?');
      return;
    }
    if (payload.startsWith('RES_PHONE:')) {
      const phone = payload.split(':')[1];
      const st = await getState(psid);
      try {
        const res = await createReservation({ customer_name: st.ctx.res_name, phone, res_date: st.ctx.res_date, time_slot: st.ctx.res_time, notes: st.ctx.res_type });
        await setState(psid, 'RESERVE_CONFIRMED', { res_id: res });
        await sendText(psid, `Reservation confirmed! Reference: RES-${res}\n${st.ctx.res_type} on ${st.ctx.res_date} at ${st.ctx.res_time}.`);
        return mainMenu(psid);
      } catch (e: any) {
        await sendText(psid, 'Could not complete the reservation. Please try again.');
        return mainMenu(psid);
      }
    }
    // Order detail view
    if (payload.startsWith('ORDER_DETAIL:')) {
      const orderId = Number(payload.split(':')[1]);
      const cust = await getCustomerByPsid(psid);
      if (!cust) return sendText(psid, 'Customer not found.');
      const order = await getOrderById(orderId);
      if (!order || order.customer_id !== cust.id) return sendText(psid, 'Order not found.');
      const items = await getOrderItems(orderId);
      const statusHistory = await getOrderStatusHistory(orderId);
      await sendOrderStatus(psid, order, statusHistory);
      // Show items
      const itemLines = items.map((item: any) => {
        const pkgItems = item.package_items?.filter(Boolean)?.map((p: any) => `   • Slot ${p.slot_number}: ${p.product_name}${p.upgrade_price > 0 ? ` (+₱${p.upgrade_price})` : ''}`).join('\n');
        return `• ${item.name} x${item.quantity} - ₱${item.line_total}${pkgItems ? '\n' + pkgItems : ''}`;
      }).join('\n');
      await sendText(psid, `📝 Items:\n${itemLines}`);
      // Show cancel button if order is still pending
      if (order.status === 'PENDING') {
        await sendQuickReplies(psid, 'Actions:', [
          { title: '❌ Cancel Order', payload: `CANCEL:${orderId}` },
          { title: '🔙 Back', payload: 'ORDER_HISTORY' },
        ]);
      } else if (order.status === 'READY') {
        // Customer can complete the order themselves once it is delivered/ready.
        await sendQuickReplies(psid, 'Actions:', [
          { title: '✅ Order Received', payload: `COMPLETE:${orderId}` },
          { title: '🔙 Back to History', payload: 'ORDER_HISTORY' },
          { title: '🏠 Main Menu', payload: 'MAIN_MENU' },
        ]);
      } else {
        await sendButtons(psid, 'Actions:', [
          { title: '🔙 Back to History', payload: 'ORDER_HISTORY' },
          { title: '🏠 Main Menu', payload: 'MAIN_MENU' },
        ]);
      }
      return;
    }
    // Reorder from history
    if (payload.startsWith('REORDER:')) {
      const orderId = Number(payload.split(':')[1]);
      const cust = await getCustomerByPsid(psid);
      if (!cust) return sendText(psid, 'Customer not found.');
      const order = await getOrderById(orderId);
      if (!order || order.customer_id !== cust.id) return sendText(psid, 'Order not found.');
      const currentCart = await getCart(psid);
      // Only warn when the current cart would be wiped.
      if (currentCart.length > 0) {
        return sendQuickReplies(psid, '⚠️ Reordering will REPLACE your current cart. Proceed?', [
          { title: '✅ Yes, replace cart', payload: `REORDER_CONFIRM:${orderId}` },
          { title: '❌ Cancel', payload: 'MENU_CART' },
        ]);
      }
      return reorderPreviousOrder(psid, orderId);
    }
    // Cancel order
    if (payload.startsWith('CANCEL:')) {
      const orderId = Number(payload.split(':')[1]);
      const cust = await getCustomerByPsid(psid);
      if (!cust) return sendText(psid, 'Customer not found.');
      const result = await cancelOrder(orderId, cust.id);
      if (result.ok) {
        await sendText(psid, '✅ Your order has been cancelled.');
      } else {
        await sendText(psid, `❌ ${result.message}`);
      }
      return mainMenu(psid);
    }
    // Customer marks a READY order as received -> COMPLETED (their own button).
    if (payload.startsWith('COMPLETE:')) {
      const orderId = Number(payload.split(':')[1]);
      const cust = await getCustomerByPsid(psid);
      if (!cust) return sendText(psid, 'Customer not found.');
      const result = await completeOrderByCustomer(orderId, cust.id);
      if (result.ok) {
        const order = await getOrderById(orderId);
        await sendText(psid, `🎉 Enjoy! Order ${order.order_number} is complete. Thank you for ordering!`);
        return sendRatingRequest(psid, order.order_number, order.id);
      }
      return sendText(psid, `ℹ️ ${result.message}`).then(() => mainMenu(psid));
    }
    // Rate order
    if (payload.startsWith('RATE:')) {
      const [, orderIdStr, ratingStr] = payload.split(':');
      const orderId = Number(orderIdStr);
      const rating = Number(ratingStr);
      const cust = await getCustomerByPsid(psid);
      if (!cust) return sendText(psid, 'Customer not found.');
      try {
        await rateOrder(orderId, cust.id, rating);
        await sendText(psid, `Thank you for your ${rating}-star rating! We appreciate your feedback.`);
      } catch (e: any) {
        await sendText(psid, `Could not submit rating: ${e.message}`);
      }
      return mainMenu(psid);
    }
    return void handlePayload(psid, payload);
  }

  if (messaging.message?.quick_reply?.payload) {
    return void handlePayload(psid, messaging.message.quick_reply.payload);
  }

  if (messaging.message?.text) {
    return void handleText(psid, messaging.message.text);
  }
}

// ---------- Meta webhook verification (GET) ----------
r.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('[webhook] verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------- Meta webhook events (POST) ----------
r.post('/', (req, res) => {
  // Remember the public origin of this request so relative /uploads/... image
  // URLs can be turned into absolute https URLs for Messenger (see
  // setRequestOrigin). Must run before any handler sends a carousel.
  setRequestOrigin(req);
  const body = req.body;
  if (body?.object === 'page') {
    for (const entry of body.entry || []) {
      for (const messaging of entry.messaging || []) {
        try { handleMessage(messaging).catch(async (e) => {
          console.error('[webhook] handler error', e);
          const psid = messaging?.sender?.id;
          if (psid) { try { await sendText(psid, 'Sorry, something went wrong. Please try again.'); } catch { /* send failed too */ } }
        }); } catch (e) { console.error('[webhook] handler error', e); }
      }
    }
    return res.status(200).send('EVENT_RECEIVED');
  }
  return res.sendStatus(404);
});

export default r;
