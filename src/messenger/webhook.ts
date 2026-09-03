import { Router } from 'express';
import { one, many, run, insertReturningId } from '../db';
import { getState, setState, sendText, sendQuickReplies, sendButtons, sendCarousel, SendResult, sendOrderConfirmation, sendOrderStatus, sendOrderHistory, sendRatingRequest } from './send';
import { getCart, addItem, removeItem, updateQuantity, cartTotals, clearCart } from '../services/cart';
import { createOrderFromCart, getCustomerOrders, getOrderById, getOrderItems, getOrderStatusHistory, cancelOrder, rateOrder } from '../services/orders';
import { slotAvailability, isDateOpen, createReservation } from '../services/reservations';
import { pricePackage, packageDefaults, computeCartTotals, netPackagePrice } from '../services/pricing';

const r = Router();

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
  const raw = (process.env.BASE_URL || '').replace(/\/+$/, '');
  if (!raw) return '';
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(raw) || /(^|\.)ngrok/i.test(raw)) {
    console.warn(`[webhook] ignoring BASE_URL="${raw}" (localhost/tunnel host, unreachable from Messenger) — using the webhook request origin instead`);
    return '';
  }
  return raw;
}
const ENV_BASE_URL = envBaseUrl();
let requestBaseUrl = '';

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
  let c = await one('SELECT * FROM customers WHERE psid = $1', [psid]) as any;
  if (!c) {
    await run('INSERT INTO customers (psid) VALUES ($1)', [psid]);
    c = await one('SELECT * FROM customers WHERE psid = $1', [psid]) as any;
  }
  return c;
}

async function mainMenu(psid: string) {
  await setState(psid, 'MAIN_MENU');
  await sendButtons(psid, '🍽️ Welcome to Postre Food Products!\n\nHow can we help you today?', [
    { title: '📋 Order Now', payload: 'MENU_ORDER' },
    { title: '🎁 Packages', payload: 'MENU_PACKAGES' },
    { title: '📖 View Menu', payload: 'MENU_BROWSE' },
  ]).then(() =>
    sendQuickReplies(psid, 'Quick actions:', [
      { title: '🛒 My Cart', payload: 'MENU_CART' },
      { title: '📍 Track Order', payload: 'TRACK_ORDER' },
      { title: '📜 Order History', payload: 'ORDER_HISTORY' },
      { title: '📅 Reservation', payload: 'MENU_RESERVE' },
      { title: '📞 Contact Us', payload: 'MENU_CONTACT' },
    ])
  );
}

function money(n: number) { return `\u20b1${n.toLocaleString('en-PH')}`; }

async function showCart(psid: string) {
  const items = await getCart(psid);
  if (items.length === 0) {
    await sendText(psid, '🛒 Your cart is empty.\n\nBrowse our menu to add items!');
    return mainMenu(psid);
  }
  const totals = await cartTotals(psid);
  const lines = await Promise.all(items.map(async (i: any) => {
    let label = `${i.quantity}x ${i.name}`;
    if (i.package_id && Array.isArray(i.slot_choices) && i.slot_choices.length) {
      const dishes = (await Promise.all(i.slot_choices
        .map(async (c: any) => (await one('SELECT name FROM products WHERE id = $1', [c.product_id]) as any)?.name)))
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
    `💰 TOTAL: ${money(totals.total)}`
  );
  return sendButtons(psid, 'What would you like to do?', [
    { title: '✅ Checkout', payload: 'CART_CHECKOUT' },
    { title: '📋 Add More', payload: 'MENU_ORDER' },
    { title: '❌ Remove Item', payload: 'CART_REMOVE' },
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
  const cats = await many('SELECT * FROM categories WHERE active = 1 ORDER BY sort_order') as any[];
  await setState(psid, 'ORDER_CATEGORY', { back: backPayload });
  await sendQuickReplies(psid, 'Choose a category:', [
    ...cats.map((c) => ({ title: `${categoryIcon(c.name)} ${c.name}`, payload: `CAT:${c.id}` })),
    { title: 'Back', payload: backPayload },
  ]);
}

async function showProducts(psid: string, categoryId: number) {
  const products = await many(
    'SELECT * FROM products WHERE category_id = $1 AND active = 1 AND unavailable = 0 ORDER BY sort_order',
    [categoryId]
  ) as any[];
  if (products.length === 0) {
    return sendText(psid, 'No products in this category yet.').then(() => showCategories(psid));
  }
  await setState(psid, 'ORDER_PRODUCT', { category_id: categoryId });
  await sendCarousel(psid, await Promise.all(products.map(async (p: any) => {
    const variants = await many('SELECT * FROM product_variants WHERE product_id = $1', [p.id]) as any[];
    const subtitle = variants.map((v) => `${v.size} ${money(v.price)}`).join(' - ');
    return {
      title: p.name,
      subtitle: `${p.description || ''}\n${subtitle}`.trim(),
      image_url: imageUrl(p.photo_url),
      buttons: [{ title: 'Order', payload: `PROD:${p.id}` }],
    };
  })));
  return sendQuickReplies(psid, 'Or pick from the list:', [
    ...products.slice(0, 10).map((p: any) => ({ title: p.name.slice(0, 20), payload: `PROD:${p.id}` })),
    { title: 'Categories', payload: 'MENU_ORDER' },
  ]);
}

async function showVariants(psid: string, productId: number): Promise<SendResult | void> {
  const product = await one('SELECT * FROM products WHERE id = $1', [productId]) as any;
  if (!product) return sendText(psid, 'Product not found.');
  const variants = await many('SELECT * FROM product_variants WHERE product_id = $1', [productId]) as any[];
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
  const v = await one('SELECT * FROM product_variants WHERE product_id = $1 AND size = $2', [productId, size]) as any;
  return sendQuickReplies(psid, `How many (${size} - ${money(v.price)})?`, [
    { title: '1', payload: `QTY:${productId}:${size}:1` },
    { title: '2', payload: `QTY:${productId}:${size}:2` },
    { title: '3', payload: `QTY:${productId}:${size}:3` },
    { title: '5', payload: `QTY:${productId}:${size}:5` },
  ]);
}

// ---------- packages ----------
async function getPackage(packageId: number) {
  return await one('SELECT * FROM packages WHERE id = $1 AND active = 1', [packageId]) as any;
}

async function showPackages(psid: string) {
  const packages = await many('SELECT * FROM packages WHERE active = 1 ORDER BY is_custom, id') as any[];
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
  const slots = await many('SELECT * FROM package_slots WHERE package_id = $1 ORDER BY slot_number', [packageId]) as any[];
  return (await Promise.all(slots.map(async (s: any) => {
    const pid = choices?.[s.slot_number];
    const prod = pid ? await one('SELECT name FROM products WHERE id = $1', [pid]) as any : null;
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

  const slots = await many('SELECT * FROM package_slots WHERE package_id = $1 ORDER BY slot_number', [packageId]) as any[];
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
  const slot = await one('SELECT * FROM package_slots WHERE package_id = $1 AND slot_number = $2', [packageId, slotNumber]) as any;
  if (!slot) return sendText(psid, 'Invalid slot.');

  let opts: { product_id: number; product_name: string; upgrade_price: number }[];
  if (pkg.is_custom) {
    // Custom package: every active menu dish is allowed (admin-defined upgrade prices still apply).
    opts = await many(`SELECT id AS product_id, name AS product_name, 0 AS upgrade_price
      FROM products WHERE active = 1 AND unavailable = 0 ORDER BY name`) as any[];
    const ups = await many(`SELECT po.product_id, po.upgrade_price FROM package_options po
      JOIN package_slots ps ON ps.id = po.slot_id WHERE ps.package_id = $1`, [packageId]) as any[];
    for (const u of ups) {
      const o = opts.find((x) => x.product_id === u.product_id);
      if (o) o.upgrade_price = u.upgrade_price || 0;
    }
  } else {
    opts = await many(`SELECT po.product_id, po.upgrade_price, p.name AS product_name
      FROM package_options po JOIN products p ON p.id = po.product_id
      WHERE po.slot_id = $1 AND p.active = 1 AND p.unavailable = 0 ORDER BY p.name`, [slot.id]) as any[];
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
    case 'MENU_ORDER':
      return showCategories(psid);
    case 'MENU_PACKAGES':
      return showPackages(psid);
    case 'MENU_BROWSE': {
      const cats = await many('SELECT * FROM categories WHERE active = 1 ORDER BY sort_order') as any[];
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
      const product = await one('SELECT * FROM products WHERE id = $1', [productId]) as any;
      const v = await one('SELECT * FROM product_variants WHERE product_id = $1 AND size = $2', [productId, size]) as any;
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
        ...items.slice(0, 10).map((i: any) => ({ title: `${i.name} (${i.size})`.slice(0, 20), payload: `REMOVE:${i.line_id}` })),
        { title: 'Cancel', payload: 'MENU_CART' },
      ]);
    }
    case 'REMOVE': {
      const lineId = Number(rest[0]);
      await removeItem(psid, lineId);
      return showCart(psid);
    }
    case 'CART_CHECKOUT':
      return checkoutStart(psid);
    case 'TYPE': {
      const type = rest[0];
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
        const cust = await one('SELECT id FROM customers WHERE psid = $1', [psid]) as any;
        if (!cust) throw new Error('Customer not found');
        // Remember contact details collected during checkout on the customer record.
        if (st.ctx.phone || st.ctx.address) {
          await run('UPDATE customers SET phone = COALESCE($1, phone), address = COALESCE($2, address) WHERE id = $3',
            [st.ctx.phone ?? null, st.ctx.address ?? null, cust.id]);
        }
        const order = await createOrderFromCart(psid, { customer_id: cust.id, order_type: st.ctx.delivery_type || 'delivery', address: st.ctx.address, notes: st.ctx.notes, payment_method: method });
        await setState(psid, 'ORDER_CONFIRMED', { order_id: order.orderId });
        const payInfo = {
          cod: 'Pay in cash when your order arrives.',
          gcash: 'GCash: 0917-000-0000 (Postre Foods). Send the receipt to confirm.',
          bank: 'BDO: 1234-5678-9012 (Postre Foods). Send the receipt to confirm.',
        }[method as 'cod'] || '';
        // Get order items for detailed confirmation
        const orderItems = await getOrderItems(order.orderId);
        await sendOrderConfirmation(psid, { ...order, order_number: order.orderNumber }, orderItems);
        await sendText(psid, payInfo);
        return mainMenu(psid);
      } catch (e: any) {
        sendText(psid, 'Sorry, something went wrong placing your order. Please try again.').then(() => mainMenu(psid));
      }
      return;
    }
    case 'TRACK_ORDER': {
      await setState(psid, 'TRACK_ORDER_INPUT');
      return sendText(psid, 'Please enter your order number (e.g., PP-1001):');
    }
    case 'ORDER_HISTORY': {
      const cust = await one('SELECT id FROM customers WHERE psid = $1', [psid]) as any;
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
    case 'MENU_RESERVE':
      await setState(psid, 'RESERVE_TYPE');
      return sendQuickReplies(psid, 'Reservation for?', [
        { title: 'Cottage', payload: 'RESTYPE:Cottage' },
        { title: 'Table', payload: 'RESTYPE:Table' },
      ]);
    case 'RESTYPE': {
      const type = rest[0];
      await setState(psid, 'RESERVE_DATE', { res_type: type });
      return sendText(psid, 'What date? (format: YYYY-MM-DD)');
    }
    case 'MENU_CONTACT':
      setState(psid, 'CONTACT_MENU');
      return sendText(psid,
        '📞 CONTACT US\n' +
        '━━━━━━━━━━━━━━━━━━━\n' +
        '📱 Phone: 0917-000-0000\n' +
        '📧 Email: hello@postre.example\n' +
        '📍 Address: 123 Sample St.\n' +
        '━━━━━━━━━━━━━━━━━━━\n' +
        '⏰ Open: Mon-Sat, 10AM-7PM'
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
      await setState(psid, 'CHECKOUT_PHONE_DONE', { ...ctx, phone: text.trim() });
      return handlePayload(psid, 'ASK_NOTES');
    case 'CHECKOUT_NOTES':
      await setState(psid, 'CHECKOUT_NOTES_DONE', { ...ctx, notes: text.trim().toLowerCase() === 'none' ? '' : text.trim() });
      return handlePayload(psid, 'ASK_PAY');
    case 'TRACK_ORDER_INPUT': {
      // Handle order tracking by order number
      const orderNumber = text.trim().toUpperCase();
      if (!orderNumber.startsWith('PP-')) {
        return sendText(psid, 'Please enter a valid order number (e.g., PP-1001):');
      }
      const cust = await one('SELECT id FROM customers WHERE psid = $1', [psid]) as any;
      if (!cust) return sendText(psid, 'Customer not found.');
      const order = await one('SELECT * FROM orders WHERE order_number = $1 AND customer_id = $2', [orderNumber, cust.id]) as any;
      if (!order) return sendText(psid, 'Order not found. Please check the number and try again.');
      const statusHistory = await getOrderStatusHistory(order.id);
      await sendOrderStatus(psid, order, statusHistory);
      return mainMenu(psid);
    }
    case 'RESERVE_DATE': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text.trim())) {
        return sendText(psid, 'Please use the date format YYYY-MM-DD, e.g. 2025-06-15:');
      }
      const dateOpen = await isDateOpen(text.trim());
      if (!dateOpen.open) {
        return sendText(psid, 'We are closed on that day. Please pick another date (YYYY-MM-DD):');
      }
      await setState(psid, 'RESERVE_TIME', { ...ctx, res_date: text.trim() });
      return sendText(psid, 'What time? (format: HH:MM, 24-hour, e.g. 15:30)');
    }
    case 'RESERVE_TIME': {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text.trim())) {
        return sendText(psid, 'Please use the time format HH:MM, e.g. 15:30:');
      }
      const slots = await slotAvailability(ctx.res_date);
      await setState(psid, 'RESERVE_SLOT', { ...ctx, res_time: text.trim() });
      return sendQuickReplies(psid, 'Choose a slot:', [
        ...slots.filter((s: any) => !s.full).map((s: any) => ({ title: `${s.label} (${s.capacity - s.used} left)`.slice(0, 20), payload: `RESSLOT:${s.label}` })),
      ]);
    }
    case 'RESERVE_NAME':
      await setState(psid, 'RESERVE_NAME_DONE', { ...ctx, res_name: text.trim() });
      return handlePayload(psid, 'RES_PHONE_ASK');
    default:
      // unknown text -> main menu
      if (text.toLowerCase().includes('menu') || text.toLowerCase().startsWith('hi')) return mainMenu(psid);
      return sendText(psid, 'Sorry, I did not understand that.').then(() => mainMenu(psid));
  }
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
      const cust = await one('SELECT id FROM customers WHERE psid = $1', [psid]) as any;
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
      const cust = await one('SELECT id FROM customers WHERE psid = $1', [psid]) as any;
      if (!cust) return sendText(psid, 'Customer not found.');
      const order = await getOrderById(orderId);
      if (!order || order.customer_id !== cust.id) return sendText(psid, 'Order not found.');
      const items = await getOrderItems(orderId);
      // Clear current cart and add items from previous order
      await clearCart(psid);
      for (const item of items) {
        if (item.package_id) {
          // For packages, we need to get the original slot choices
          const pkgChoices = item.package_items?.filter(Boolean)?.map((p: any) => ({
            slot_number: p.slot_number,
            product_id: p.product_id,
          })) || [];
          await addItem(psid, {
            package_id: item.package_id,
            variant_size: item.variant_size,
            quantity: item.quantity,
            slot_choices: pkgChoices,
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
      return showCart(psid);
    }
    // Cancel order
    if (payload.startsWith('CANCEL:')) {
      const orderId = Number(payload.split(':')[1]);
      const cust = await one('SELECT id FROM customers WHERE psid = $1', [psid]) as any;
      if (!cust) return sendText(psid, 'Customer not found.');
      const result = await cancelOrder(orderId, cust.id);
      if (result.ok) {
        await sendText(psid, '✅ Your order has been cancelled.');
      } else {
        await sendText(psid, `❌ ${result.message}`);
      }
      return mainMenu(psid);
    }
    // Rate order
    if (payload.startsWith('RATE:')) {
      const [, orderIdStr, ratingStr] = payload.split(':');
      const orderId = Number(orderIdStr);
      const rating = Number(ratingStr);
      const cust = await one('SELECT id FROM customers WHERE psid = $1', [psid]) as any;
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
        try { handleMessage(messaging); } catch (e) { console.error('[webhook] handler error', e); }
      }
    }
    return res.status(200).send('EVENT_RECEIVED');
  }
  return res.sendStatus(404);
});

export default r;
