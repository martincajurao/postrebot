import { Router } from 'express';
import { db } from '../db/database';
import { getState, setState, sendText, sendQuickReplies, sendButtons, sendCarousel, SendResult } from './send';
import { getCart, addItem, removeItem, updateQuantity, cartTotals } from '../services/cart';
import { createOrderFromCart } from '../services/orders';
import { slotAvailability, isDateOpen, createReservation } from '../services/reservations';
import { pricePackage, packageDefaults, computeCartTotals, netPackagePrice } from '../services/pricing';

const r = Router();

const BASE_URL = process.env.BASE_URL || '';
/** Messenger requires absolute https URLs for images. */
function absUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\//.test(url)) return url;
  if (!BASE_URL) return undefined; // no public URL configured -> skip image
  return BASE_URL.replace(/\/$/, '') + url;
}

// ---------- helpers ----------
function ensureCustomer(psid: string) {
  let c = db.prepare('SELECT * FROM customers WHERE psid = ?').get(psid) as any;
  if (!c) {
    db.prepare('INSERT INTO customers (psid) VALUES (?)').run(psid);
    c = db.prepare('SELECT * FROM customers WHERE psid = ?').get(psid) as any;
  }
  return c;
}

function mainMenu(psid: string) {
  setState(psid, 'MAIN_MENU');
  sendButtons(psid, 'Welcome to Postre Food Products!\n\nHow can we help you today?', [
    { title: 'Order Now', payload: 'MENU_ORDER' },
    { title: 'Packages', payload: 'MENU_PACKAGES' },
    { title: 'Menu', payload: 'MENU_BROWSE' },
  ]).then(() =>
    sendQuickReplies(psid, 'More options:', [
      { title: 'Reservation', payload: 'MENU_RESERVE' },
      { title: 'My Cart', payload: 'MENU_CART' },
      { title: 'Contact Us', payload: 'MENU_CONTACT' },
    ])
  );
}

function money(n: number) { return `\u20b1${n.toLocaleString('en-PH')}`; }

async function showCart(psid: string) {
  const items = getCart(psid);
  if (items.length === 0) {
    await sendText(psid, 'Your cart is empty.');
    return mainMenu(psid);
  }
  const totals = cartTotals(psid);
  const lines = items.map((i: any) => {
    let label = `${i.quantity}x ${i.name}`;
    if (i.package_id && Array.isArray(i.slot_choices) && i.slot_choices.length) {
      const dishes = i.slot_choices
        .map((c: any) => (db.prepare('SELECT name FROM products WHERE id = ?').get(c.product_id) as any)?.name)
        .filter(Boolean).join(', ');
      if (dishes) label += `\n(${dishes})`;
    }
    let lineTotal = 0;
    try { lineTotal = computeCartTotals([i], 0).subtotal; } catch { lineTotal = 0; }
    return `${label} — ${money(lineTotal)}`;
  }).join('\n');
  await sendText(psid, `YOUR CART\n\n${lines}\n\nTotal: ${money(totals.total)}`);
  return sendButtons(psid, 'What would you like to do?', [
    { title: 'Checkout', payload: 'CART_CHECKOUT' },
    { title: 'Add More', payload: 'MENU_ORDER' },
    { title: 'Remove Item', payload: 'CART_REMOVE' },
  ]);
}

function showCategories(psid: string, backPayload = 'MAIN_MENU_BACK') {
  const cats = db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY sort_order').all() as any[];
  setState(psid, 'ORDER_CATEGORY', { back: backPayload });
  sendQuickReplies(psid, 'Choose a category:', [
    ...cats.map((c) => ({ title: c.name, payload: `CAT:${c.id}` })),
    { title: 'Back', payload: backPayload },
  ]);
}

function showProducts(psid: string, categoryId: number) {
  const products = db.prepare(
    'SELECT * FROM products WHERE category_id = ? AND active = 1 AND unavailable = 0 ORDER BY sort_order'
  ).all(categoryId) as any[];
  if (products.length === 0) {
    return sendText(psid, 'No products in this category yet.').then(() => showCategories(psid));
  }
  setState(psid, 'ORDER_PRODUCT', { category_id: categoryId });
  sendCarousel(psid, products.map((p: any) => {
    const variants = db.prepare('SELECT * FROM product_variants WHERE product_id = ?').all(p.id) as any[];
    const subtitle = variants.map((v) => `${v.size} ${money(v.price)}`).join(' - ');
    return {
      title: p.name,
      subtitle: `${p.description || ''}\n${subtitle}`.trim(),
      image_url: absUrl(p.photo_url),
      buttons: [{ title: 'Order', payload: `PROD:${p.id}` }],
    };
  })).then(() =>
    sendQuickReplies(psid, 'Or pick from the list:', [
      ...products.slice(0, 10).map((p: any) => ({ title: p.name.slice(0, 20), payload: `PROD:${p.id}` })),
      { title: 'Categories', payload: 'MENU_ORDER' },
    ])
  );
}

async function showVariants(psid: string, productId: number): Promise<SendResult | void> {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as any;
  if (!product) return sendText(psid, 'Product not found.');
  const variants = db.prepare('SELECT * FROM product_variants WHERE product_id = ?').all(productId) as any[];
  setState(psid, 'ORDER_VARIANT', { product_id: productId });
  if (variants.length === 1) {
    return handlePayload(psid, `SIZE:${productId}:${variants[0].size}`);
  }
  sendQuickReplies(psid, `Select a size for ${product.name}:`, [
    ...variants.map((v) => ({ title: `${v.size} ${money(v.price)}`.slice(0, 20), payload: `SIZE:${productId}:${v.size}` })),
    { title: 'Back', payload: `CAT:${product.category_id}` },
  ]);
}

function showQuantity(psid: string, productId: number, size: string) {
  setState(psid, 'ORDER_QUANTITY', { product_id: productId, size });
  const v = db.prepare('SELECT * FROM product_variants WHERE product_id = ? AND size = ?').get(productId, size) as any;
  sendQuickReplies(psid, `How many (${size} - ${money(v.price)})?`, [
    { title: '1', payload: `QTY:${productId}:${size}:1` },
    { title: '2', payload: `QTY:${productId}:${size}:2` },
    { title: '3', payload: `QTY:${productId}:${size}:3` },
    { title: '5', payload: `QTY:${productId}:${size}:5` },
  ]);
}

// ---------- packages ----------
function getPackage(packageId: number) {
  return db.prepare('SELECT * FROM packages WHERE id = ? AND active = 1').get(packageId) as any;
}

function showPackages(psid: string) {
  const packages = db.prepare('SELECT * FROM packages WHERE active = 1 ORDER BY is_custom, id').all() as any[];
  setState(psid, 'PACKAGE_LIST');
  if (packages.length === 0) return sendText(psid, 'No packages available right now.');
  const elements = packages.map((p: any) => p.is_custom ? {
    title: p.name,
    subtitle: `${money(p.base_price)} base — Pick any ${p.selections} dishes you like`,
    image_url: absUrl(p.photo_url),
    buttons: [{ title: 'Start Building', payload: `PKG:${p.id}` }],
  } : {
    title: p.name,
    subtitle: `${money(netPackagePrice(p))}${p.discount > 0 ? ` — Save ${money(p.discount)}` : ''} — ${p.is_fixed ? `Fixed: ${p.selections} dishes, ready to order` : `Choose ${p.selections} dishes`}`,
    image_url: absUrl(p.photo_url),
    buttons: [{ title: 'View Package', payload: `PKG:${p.id}` }],
  });
  return sendCarousel(psid, elements);
}

function packageLines(packageId: number, choices: Record<number, number>): string {
  const slots = db.prepare('SELECT * FROM package_slots WHERE package_id = ? ORDER BY slot_number').all(packageId) as any[];
  return slots.map((s: any) => {
    const pid = choices?.[s.slot_number];
    const prod = pid ? db.prepare('SELECT name FROM products WHERE id = ?').get(pid) as any : null;
    return `${s.slot_number}. ${prod ? prod.name : '(not chosen yet)'}`;
  }).join('\n');
}

/** Authoritative total for a complete set of choices, or null when incomplete/invalid. */
function packageTotal(packageId: number, choices: Record<number, number>, size: string): number | null {
  const pkg = getPackage(packageId);
  if (!pkg) return null;
  const arr = Object.entries(choices || {}).map(([k, v]) => ({ slot_number: Number(k), product_id: Number(v) }));
  if (arr.length !== pkg.selections) return null;
  try {
    return pricePackage(packageId, arr, size).total;
  } catch {
    return null;
  }
}

function showPackageDetails(psid: string, packageId: number, ctx?: any) {
  const pkg = getPackage(packageId);
  if (!pkg) return sendText(psid, 'Package not found.');
  const prev = ctx || getState(psid).ctx;
  const saved: Record<number, number> = {};
  if (prev && prev.package_id === packageId && prev.choices) {
    for (const [k, v] of Object.entries(prev.choices)) saved[Number(k)] = Number(v);
  }
  const defaults: Record<number, number> = {};
  for (const d of packageDefaults(packageId)) defaults[d.slot_number] = d.product_id;
  const choices: Record<number, number> = pkg.is_custom ? { ...saved } : { ...defaults, ...saved };
  setState(psid, 'PACKAGE_DETAILS', { package_id: packageId, choices });

  if (pkg.is_fixed) {
    const mTotal = packageTotal(packageId, choices, 'M') ?? netPackagePrice(pkg);
    const lTotal = packageTotal(packageId, choices, 'L') ?? netPackagePrice(pkg);
    const saveNote = pkg.discount > 0 ? ` (was ${money(pkg.base_price)} — Save ${money(pkg.discount)})` : '';
    return sendText(psid, `${pkg.name}\n${money(mTotal)}${saveNote}\n\n${packageLines(packageId, choices)}`)
      .then(() => sendQuickReplies(psid, 'This package is ready to order:', [
        { title: `Add M ${money(mTotal)}`.slice(0, 20), payload: `PKGADD:${packageId}:M:1` },
        { title: `Add L ${money(lTotal)}`.slice(0, 20), payload: `PKGADD:${packageId}:L:1` },
        { title: 'Packages', payload: 'MENU_PACKAGES' },
      ]));
  }

  const slots = db.prepare('SELECT * FROM package_slots WHERE package_id = ? ORDER BY slot_number').all(packageId) as any[];
  const filled = Object.keys(choices).length;
  const header = pkg.is_custom
    ? `${pkg.name}\n${money(pkg.base_price)} base\n\nPick any ${pkg.selections} dishes (${filled}/${pkg.selections} chosen):\n\n${packageLines(packageId, choices)}`
    : `${pkg.name}\n${money(netPackagePrice(pkg))}${pkg.discount > 0 ? ` — Save ${money(pkg.discount)}` : ''}\n\n${packageLines(packageId, choices)}`;
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

function showSlotOptions(psid: string, packageId: number, slotNumber: number, page = 0) {
  const st = getState(psid);
  const pkg = getPackage(packageId);
  if (!pkg) return sendText(psid, 'Package not found.');
  const slot = db.prepare('SELECT * FROM package_slots WHERE package_id = ? AND slot_number = ?').get(packageId, slotNumber) as any;
  if (!slot) return sendText(psid, 'Invalid slot.');

  let opts: { product_id: number; product_name: string; upgrade_price: number }[];
  if (pkg.is_custom) {
    // Custom package: every active menu dish is allowed (admin-defined upgrade prices still apply).
    opts = db.prepare(`SELECT id AS product_id, name AS product_name, 0 AS upgrade_price
      FROM products WHERE active = 1 AND unavailable = 0 ORDER BY name`).all() as any[];
    const ups = db.prepare(`SELECT po.product_id, po.upgrade_price FROM package_options po
      JOIN package_slots ps ON ps.id = po.slot_id WHERE ps.package_id = ?`).all(packageId) as any[];
    for (const u of ups) {
      const o = opts.find((x) => x.product_id === u.product_id);
      if (o) o.upgrade_price = u.upgrade_price || 0;
    }
  } else {
    opts = db.prepare(`SELECT po.product_id, po.upgrade_price, p.name AS product_name
      FROM package_options po JOIN products p ON p.id = po.product_id
      WHERE po.slot_id = ? AND p.active = 1 AND p.unavailable = 0 ORDER BY p.name`).all(slot.id) as any[];
  }
  if (opts.length === 0) return sendText(psid, 'No dishes available for this slot right now.');

  const PAGE = 10;
  const pages = Math.ceil(opts.length / PAGE);
  const safePage = Math.max(0, Math.min(page, pages - 1));
  const ctx = st.ctx.package_id === packageId ? st.ctx : { package_id: packageId, choices: {} };
  setState(psid, 'SELECT_OPTION', { ...ctx, slot_number: slotNumber });
  const replies = opts.slice(safePage * PAGE, safePage * PAGE + PAGE).map((o) => ({
    title: `${o.product_name}${o.upgrade_price > 0 ? ` +${money(o.upgrade_price)}` : ''}`.slice(0, 20),
    payload: `CHOICE:${packageId}:${slotNumber}:${o.product_id}`,
  }));
  if (safePage + 1 < pages) replies.push({ title: 'More options...', payload: `SLOTPG:${packageId}:${slotNumber}:${safePage + 1}` });
  if (safePage > 0) replies.push({ title: 'Previous page', payload: `SLOTPG:${packageId}:${slotNumber}:${safePage - 1}` });
  return sendQuickReplies(psid, `Choose dish for slot #${slotNumber}:`, replies);
}

function afterChoice(psid: string, packageId: number, slotNumber: number, productId: number) {
  const st = getState(psid);
  const base = st.ctx && st.ctx.package_id === packageId ? st.ctx : { package_id: packageId, choices: {} };
  const ctx = { ...base, choices: { ...(base.choices || {}), [slotNumber]: productId } };
  return showPackageDetails(psid, packageId, ctx);
}

function showPackageSize(psid: string, packageId: number, ctx?: any) {
  const c = ctx || getState(psid).ctx;
  const choices: Record<number, number> = {};
  if (c && c.choices) for (const [k, v] of Object.entries(c.choices)) choices[Number(k)] = Number(v);
  setState(psid, 'PACKAGE_SIZE', { package_id: packageId, choices });
  const pkg = getPackage(packageId);
  const m = packageTotal(packageId, choices, 'M');
  const l = packageTotal(packageId, choices, 'L');
  const priceLine = m != null ? `\n\nTotal M: ${money(m)} | Total L: ${money(l ?? (pkg ? netPackagePrice(pkg) : 0))}` : '';
  return sendQuickReplies(psid, `Package dish size? (L may add an upgrade fee)${priceLine}`, [
    { title: 'M - Included', payload: `PKGADD:${packageId}:M:1` },
    { title: 'L + Upgrade', payload: `PKGADD:${packageId}:L:1` },
    { title: 'Back to Menu', payload: 'MAIN_MENU_BACK' },
  ]);
}

function checkoutStart(psid: string) {
  const items = getCart(psid);
  if (items.length === 0) return sendText(psid, 'Your cart is empty.');
  setState(psid, 'CHECKOUT_TYPE');
  sendQuickReplies(psid, 'Delivery or Pickup?', [
    { title: 'Delivery', payload: 'TYPE:delivery' },
    { title: 'Pickup', payload: 'TYPE:pickup' },
  ]);
}

function addPackageToCart(psid: string, packageId: number, size: string, qty: number) {
  const pkg = getPackage(packageId);
  if (!pkg) return sendText(psid, 'Package not found.');
  const chosenSize = size.toUpperCase() === 'L' ? 'L' : 'M';
  const st = getState(psid).ctx;
  const choices: Record<number, number> = {};
  if (st && st.package_id === packageId && st.choices) {
    for (const [k, v] of Object.entries(st.choices)) choices[Number(k)] = Number(v);
  }
  if (Object.keys(choices).length === 0) {
    for (const d of packageDefaults(packageId)) choices[d.slot_number] = d.product_id;
  }
  if (Object.keys(choices).length !== pkg.selections) {
    return showPackageDetails(psid, packageId, { package_id: packageId, choices });
  }
  const arr = Object.entries(choices).map(([k, v]) => ({ slot_number: Number(k), product_id: Number(v) }));
  let total = netPackagePrice(pkg);
  try { total = pricePackage(packageId, arr, chosenSize).total; } catch { /* fall back to base price */ }
  addItem(psid, { package_id: packageId, variant_size: chosenSize, quantity: qty, slot_choices: arr });
  return sendText(psid, `Added ${qty}x ${pkg.name} (${chosenSize}) to your cart.\n\n${packageLines(packageId, choices)}\nPrice: ${money(total)}`)
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
      const cats = db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY sort_order').all() as any[];
      setState(psid, 'BROWSE_CATEGORY');
      return sendQuickReplies(psid, 'Browse our menu:', [
        ...cats.map((c) => ({ title: c.name, payload: `BROWSE:${c.id}` })),
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
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as any;
      const v = db.prepare('SELECT * FROM product_variants WHERE product_id = ? AND size = ?').get(productId, size) as any;
      addItem(psid, { product_id: productId, variant_size: size, quantity: qty });
      sendText(psid, `Added ${qty}x ${product.name} (${size}) to your cart.`)
        .then(() => sendButtons(psid, 'What next?', [
          { title: 'View Cart', payload: 'MENU_CART' },
          { title: 'Checkout', payload: 'CART_CHECKOUT' },
          { title: 'Keep Shopping', payload: 'MENU_ORDER' },
        ]));
      return;
    }
    case 'MENU_CART':
      return showCart(psid);
    case 'CART_REMOVE': {
      const items = getCart(psid);
      if (items.length === 0) return sendText(psid, 'Your cart is empty.');
      setState(psid, 'CART_REMOVE_ITEM');
      return sendQuickReplies(psid, 'Remove which item?', [
        ...items.slice(0, 10).map((i: any) => ({ title: `${i.name} (${i.size})`.slice(0, 20), payload: `REMOVE:${i.line_id}` })),
        { title: 'Cancel', payload: 'MENU_CART' },
      ]);
    }
    case 'REMOVE': {
      const lineId = Number(rest[0]);
      removeItem(psid, lineId);
      return showCart(psid);
    }
    case 'CART_CHECKOUT':
      return checkoutStart(psid);
    case 'TYPE': {
      const type = rest[0];
      setState(psid, 'CHECKOUT_ADDRESS', { delivery_type: type });
      if (type === 'pickup') return handlePayload(psid, 'ASK_PHONE');
      return sendText(psid, 'Please type your delivery address (house #, street, barangay, city):');
    }
    case 'ASK_PHONE':
      setState(psid, 'CHECKOUT_PHONE', getState(psid).ctx);
      return sendText(psid, 'Please type your contact number:');
    case 'ASK_NOTES':
      setState(psid, 'CHECKOUT_NOTES', getState(psid).ctx);
      return sendText(psid, 'Any special notes? (type "none" to skip)');
    case 'ASK_PAY':
      setState(psid, 'CHECKOUT_PAY', getState(psid).ctx);
      return sendQuickReplies(psid, 'Payment method:', [
        { title: 'COD', payload: 'PAY:cod' },
        { title: 'GCash', payload: 'PAY:gcash' },
        { title: 'Bank Transfer', payload: 'PAY:bank' },
      ]);
    case 'PAY': {
      const method = rest[0];
      const st = getState(psid);
      try {
        const cust = db.prepare('SELECT id FROM customers WHERE psid = ?').get(psid) as any;
        if (!cust) throw new Error('Customer not found');
        // Remember contact details collected during checkout on the customer record.
        if (st.ctx.phone || st.ctx.address) {
          db.prepare('UPDATE customers SET phone = COALESCE(?, phone), address = COALESCE(?, address) WHERE id = ?')
            .run(st.ctx.phone ?? null, st.ctx.address ?? null, cust.id);
        }
        const order = createOrderFromCart(psid, { customer_id: cust.id, order_type: st.ctx.delivery_type || 'delivery', address: st.ctx.address, notes: st.ctx.notes, payment_method: method });
        setState(psid, 'ORDER_CONFIRMED', { order_id: order.orderId });
        const payInfo = {
          cod: 'Pay in cash when your order arrives.',
          gcash: 'GCash: 0917-000-0000 (Postre Foods). Send the receipt to confirm.',
          bank: 'BDO: 1234-5678-9012 (Postre Foods). Send the receipt to confirm.',
        }[method as 'cod'] || '';
        sendText(psid, `Order #${order.orderNumber} confirmed!\nTotal: ${money(order.total)}\n\n${payInfo}`)
          .then(() => mainMenu(psid));
      } catch (e: any) {
        sendText(psid, 'Sorry, something went wrong placing your order. Please try again.').then(() => mainMenu(psid));
      }
      return;
    }
    case 'PKG':
      return showPackageDetails(psid, Number(rest[0]));
    case 'SLOT':
      return showSlotOptions(psid, Number(rest[0]), Number(rest[1]));
    case 'SLOTPG':
      return showSlotOptions(psid, Number(rest[0]), Number(rest[1]), Number(rest[2] || 0));
    case 'CHOICE':
      return afterChoice(psid, Number(rest[0]), Number(rest[1]), Number(rest[2]));
    case 'PKGSIZE':
      return showPackageSize(psid, Number(rest[0]));
    case 'PKGADD':
      return addPackageToCart(psid, Number(rest[0]), rest[1], Number(rest[2]));
    case 'MENU_RESERVE':
      setState(psid, 'RESERVE_TYPE');
      return sendQuickReplies(psid, 'Reservation for?', [
        { title: 'Cottage', payload: 'RESTYPE:Cottage' },
        { title: 'Table', payload: 'RESTYPE:Table' },
      ]);
    case 'RESTYPE': {
      const type = rest[0];
      setState(psid, 'RESERVE_DATE', { res_type: type });
      return sendText(psid, 'What date? (format: YYYY-MM-DD)');
    }
    case 'MENU_CONTACT':
      setState(psid, 'CONTACT_MENU');
      return sendText(psid, 'Contact us:\nPhone: 0917-000-0000\nEmail: hello@postre.example\nAddress: 123 Sample St.')
        .then(() => mainMenu(psid));
    default:
      return mainMenu(psid);
  }
}

async function handleText(psid: string, text: string) {
  const st = getState(psid);
  const state = st.state;
  const ctx = st.ctx || {};

  switch (state) {
    case 'CHECKOUT_ADDRESS':
      setState(psid, 'CHECKOUT_ADDRESS_DONE', { ...ctx, address: text });
      return handlePayload(psid, 'ASK_PHONE');
    case 'CHECKOUT_PHONE':
      if (!/^[0-9+\-\s()]{7,15}$/.test(text.trim())) {
        return sendText(psid, 'That does not look like a valid phone number. Please try again:');
      }
      setState(psid, 'CHECKOUT_PHONE_DONE', { ...ctx, phone: text.trim() });
      return handlePayload(psid, 'ASK_NOTES');
    case 'CHECKOUT_NOTES':
      setState(psid, 'CHECKOUT_NOTES_DONE', { ...ctx, notes: text.trim().toLowerCase() === 'none' ? '' : text.trim() });
      return handlePayload(psid, 'ASK_PAY');
    case 'RESERVE_DATE': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text.trim())) {
        return sendText(psid, 'Please use the date format YYYY-MM-DD, e.g. 2025-06-15:');
      }
      if (!isDateOpen(text.trim())) {
        return sendText(psid, 'We are closed on that day. Please pick another date (YYYY-MM-DD):');
      }
      setState(psid, 'RESERVE_TIME', { ...ctx, res_date: text.trim() });
      return sendText(psid, 'What time? (format: HH:MM, 24-hour, e.g. 15:30)');
    }
    case 'RESERVE_TIME': {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text.trim())) {
        return sendText(psid, 'Please use the time format HH:MM, e.g. 15:30:');
      }
      const slots = slotAvailability(ctx.res_date);
      setState(psid, 'RESERVE_SLOT', { ...ctx, res_time: text.trim() });
      return sendQuickReplies(psid, 'Choose a slot:', [
        ...slots.filter((s: any) => !s.full).map((s: any) => ({ title: `${s.label} (${s.capacity - s.used} left)`.slice(0, 20), payload: `RESSLOT:${s.label}` })),
      ]);
    }
    case 'RESERVE_NAME':
      setState(psid, 'RESERVE_NAME_DONE', { ...ctx, res_name: text.trim() });
      return handlePayload(psid, 'RES_PHONE_ASK');
    default:
      // unknown text -> main menu
      if (text.toLowerCase().includes('menu') || text.toLowerCase().startsWith('hi')) return mainMenu(psid);
      return sendText(psid, 'Sorry, I did not understand that.').then(() => mainMenu(psid));
  }
}

export function handleMessage(messaging: any) {
  const psid = messaging.sender?.id;
  if (!psid) return;
  ensureCustomer(psid);

  if (messaging.postback?.payload) {
    const payload = messaging.postback.payload;
    if (payload.startsWith('RESSLOT:')) {
      const timeSlot = payload.slice('RESSLOT:'.length);
      const st = getState(psid);
      setState(psid, 'RESERVE_NAME', { ...st.ctx, res_time: timeSlot });
      sendText(psid, 'Name for the reservation?');
      return;
    }
    if (payload === 'RES_PHONE_ASK') {
      setState(psid, 'RESERVE_PHONE', getState(psid).ctx);
      sendText(psid, 'Contact number for the reservation?');
      return;
    }
    if (payload.startsWith('RES_PHONE:')) {
      const phone = payload.split(':')[1];
      const st = getState(psid);
      try {
        const res = createReservation({ customer_name: st.ctx.res_name, phone, res_date: st.ctx.res_date, time_slot: st.ctx.res_time, notes: st.ctx.res_type });
        setState(psid, 'RESERVE_CONFIRMED', { res_id: res });
        sendText(psid, `Reservation confirmed! Reference: RES-${res}\n${st.ctx.res_type} on ${st.ctx.res_date} at ${st.ctx.res_time}.`)
          .then(() => mainMenu(psid));
      } catch (e: any) {
        sendText(psid, 'Could not complete the reservation. Please try again.').then(() => mainMenu(psid));
      }
      return;
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
