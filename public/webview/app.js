﻿// ===== Postre Food Products — Webview (order online) =====
// Refactored so every field the REST API returns is reflected on the page:
// categories, products + variants, packages + slots/options + upgrades + discounts,
// food packs, cart line pricing, checkout, order history with item detail, and the
// store contact config. All data rendered via the API is HTML-escaped.
//
// Primary data source: /api/webview REST endpoints.
// Direct-to-Supabase is only a fallback when the REST API is unreachable.

const SUPABASE_URL = 'https://npftxbstixrhuiaqpmap.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wZnR4YnN0aXhyaHVpYXFwbWFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4MTQwMDQsImV4cCI6MjEwMzM5MDAwNH0.9NFykxXdzeVfNRd4KikObsCmNsW2Ex3mFjftMLuWxMU';

let sb = null;
function getSupabaseClient() {
  if (sb) return sb;
  try {
    if (typeof supabase !== 'undefined' && supabase.createClient) {
      sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    } else {
      console.warn('[webview] Supabase JS not loaded — relying on /api/webview REST endpoints.');
    }
  } catch (e) {
    console.warn('[webview] Failed to init Supabase client:', e);
  }
  return sb;
}

// Some in-app webviews disable localStorage and throw on any access.
function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* non-fatal */ }
}

// Session management — when opened from Messenger we receive a ?psid= parameter
// which identifies the customer. Use it as the session so orders link to their account.
const urlParams = new URLSearchParams(window.location.search);
const psidFromMessenger = urlParams.get('psid') || '';

let sessionId = psidFromMessenger || storageGet('webview_session');
if (!sessionId) {
  sessionId = 'wv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  storageSet('webview_session', sessionId);
}

// Surface any runtime JS error so console debugging always shows it.
window.addEventListener('error', (e) => {
  console.error('[webview] uncaught error:', e && e.error ? e.error.stack || e.error : (e && e.message));
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[webview] unhandled rejection:', e && e.reason ? (e.reason.stack || e.reason) : e);
});

// ---------- State ----------
let categories = [];
let products = [];
let packages = [];
let foodPacks = [];
let cart = { items: [], totals: { subtotal: 0, delivery: 0, discount: 0, total: 0, breakdown: [] } };
let orders = [];
let config = { payment: {}, contact: {} };
let serverMapsApiKey = '';
let isInsideMessenger = false;
let currentView = 'categories';
let currentCategoryId = null;
let productDetail = { productId: null, size: null, qty: 1 };
let packageDetail = { pkgId: null, choices: {}, size: 'M', qty: 1 };
let foodPackDetail = { fpId: null, pieces: 10 };
const FOOD_PACK_MIN_PIECES = 10;

// ---------- Helpers ----------
const $id = (id) => document.getElementById(id);

/** Escape a value before inserting it into innerHTML (prevents broken HTML & XSS). */
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function formatMoney(n) {
  return '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** Resolve relative /uploads/... URLs against the app origin. */
function absUrl(u) {
  if (!u) return u;
  if (/^https?:\/\//i.test(u)) return u;
  return u.startsWith('/') ? u : '/' + u;
}

/** Image with a graceful fallback for missing/broken photos. Click opens fullscreen lightbox. */
function imageHtml(url, alt, cls) {
  url = absUrl(url);
  const altText = esc(alt || '');
  const wrapCls = `img-wrap${cls ? ' ' + cls : ''}`.trim();

  if (!url) {
    // No photo stored — show an icon placeholder so the card slot isn't empty.
    return `<div class="${wrapCls} no-image"><span class="img-placeholder" aria-hidden="true">📷</span></div>`;
  }

  // On error: mark the wrapper so CSS hides the broken <img> and shows the fallback icon.
  // While the bitmap fetches, the img carries the .img-skel shimmer (removed on load/error).
  // Click opens the fullscreen image lightbox.
  const lightboxOnclick = `onclick="openImageLightbox(event, '${esc(url)}', '${altText}');"`;
  const imgCls = `img-skel${cls ? ' ' + cls : ''}`;
  return `<div class="${wrapCls}" ${lightboxOnclick} style="cursor:zoom-in"><img class="${imgCls}" src="${esc(url)}" alt="${altText}" loading="lazy" onload="this.classList.remove('img-skel')" onerror="this.onerror=null;this.classList.remove('img-skel');this.parentNode.classList.add('img-broken')"><span class="img-fallback" aria-hidden="true">📷</span></div>`;
}

function showToast(msg) {
  const t = $id('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add('hidden'), 2500);
}

// ---------- Image lightbox ----------
// Tap a thumbnail → fullscreen overlay with the full-size photo.
// Tapping anywhere on the overlay (or the ✕) closes it.
function openImageLightbox(event, url, name) {
  if (event && event.stopPropagation) event.stopPropagation();
  let lb = document.getElementById('img-lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'img-lightbox';
    lb.className = 'img-lightbox';
    lb.addEventListener('click', closeImageLightbox);
    document.body.appendChild(lb);
  }
  lb.innerHTML = `<img class="img-lightbox-img img-skel" src="${esc(absUrl(url))}" alt="${esc(name || '')}" onload="this.classList.remove('img-skel')" onerror="this.classList.remove('img-skel')">`;
  lb.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeImageLightbox() {
  const lb = document.getElementById('img-lightbox');
  if (!lb) return;
  lb.classList.remove('open');
  document.body.style.overflow = '';
}

// #loading-view has an inline display:flex that beats the .view{display:none} rule,
// so toggling the 'active' class alone never hides the spinner. Set the inline
// display explicitly instead.
function showLoading(msg) {
  const el = $id('loading-view');
  if (!el) return;
  const txt = $id('loading-text');
  if (txt && msg) txt.textContent = msg;
  el.classList.add('active');
  el.style.display = 'flex';
}
function hideLoading() {
  const el = $id('loading-view');
  if (!el) return;
  const txt = $id('loading-text');
  if (txt) txt.textContent = 'Loading...';
  el.classList.remove('active');
  el.style.display = 'none';
}

// Views start with class "view hidden" and .hidden is display:none !important,
// so toggling only 'active' (like the old code) left every section invisible.
// Toggle both classes here so the requested view is always the one on screen.
function showView(id) {
  document.querySelectorAll('.view').forEach((v) => {
    if (v.id === id) {
      v.classList.add('active');
      v.classList.remove('hidden');
    } else {
      v.classList.remove('active');
      v.classList.add('hidden');
    }
  });
  // #loading-view has an inline display:flex that beats class rules — clear it.
  const loading = $id('loading-view');
  if (loading && id !== 'loading-view') loading.style.display = 'none';
  currentView = id.replace('view-', '');
  updateBottomNav();
  renderCartBar();
}

/** Bottom nav index per view. */
const NAV_MAP = {
  'categories': 0, 'products': 0, 'product-detail': 0,
  'packages': 1, 'package': 1,
  'cart': 2, 'checkout': 2,
  'food-packs': 3, 'food-pack-detail': 3,
  'orders': 4, 'order-detail': 4,
};

function updateBottomNav() {
  const idx = NAV_MAP[currentView];
  if (idx === undefined) return;
  document.querySelectorAll('.nav-btn').forEach((btn, i) => {
    btn.classList.toggle('active', i === idx);
  });
}

function goBack() {
  if (currentView === 'product-detail') showProducts(currentCategoryId);
  else if (currentView === 'package') showPackages();
  else if (currentView === 'food-pack-detail') showFoodPacks();
  else showCategories();
}

let prevCartCount = 0;

function updateCartBadge() {
  const badge = $id('cart-badge');
  const headerBadge = $id('header-cart-badge');
  const count = cart.items.reduce((s, i) => s + i.quantity, 0);
  
  if (badge) {
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
  }
  
  if (headerBadge) {
    headerBadge.textContent = count;
    headerBadge.classList.toggle('hidden', count === 0);
  }

  // Animate badge when item is added (count increases)
  if (count > prevCartCount) {
    if (badge) {
      badge.classList.remove('badge-bounce');
      void badge.offsetWidth; // Trigger reflow to restart animation
      badge.classList.add('badge-bounce');
    }
    if (headerBadge) {
      headerBadge.classList.remove('badge-pop');
      void headerBadge.offsetWidth; // Trigger reflow to restart animation
      headerBadge.classList.add('badge-pop');
    }
  }
  prevCartCount = count;
}
// ---------- Category icon mapping (mirrors the Messenger bot) ----------
const CATEGORY_ICONS = [
  [/chicken|manok/i, '🍗'],
  [/pork|lechon|baboy|ham/i, '🐖'],
  [/beef|steak|karne/i, '🥩'],
  [/seafood|fish|shrimp|crab|scallop|kinilaw|salmon|tilapia/i, '🦐'],
  [/noodle|pancit|palabok|pasta|carbonara|spaghetti|bam-i|lomi|mami/i, '🍜'],
  [/vegetable|veggie|chopsuey|salad/i, '🥬'],
  [/dessert|cake|crepe|sweet|leche|halo|ice/i, '🍰'],
  [/rice/i, '🍚'],
  [/drink|beverage|juice|soda|tea|coffee/i, '🥤'],
  [/bilao|platter|combo|package|party/i, '🥘'],
];
const DEFAULT_CATEGORY_ICON = '🍴';
function categoryIcon(name) {
  for (const [re, icon] of CATEGORY_ICONS) {
    if (re.test(name || '')) return icon;
  }
  return DEFAULT_CATEGORY_ICON;
}

// ---------- REST API ----------
/** Fetch a /api/webview endpoint. Throws on any failure so callers can fall back. */
async function api(path, opts = {}) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 30000) : null;
  let res;
  try {
    res = await fetch('/api/webview' + path, {
      headers: { 'Content-Type': 'application/json' },
      signal: controller ? controller.signal : undefined,
      ...opts,
    });
  } catch (e) {
    throw new Error(e && e.name === 'AbortError' ? 'Request timed out' : 'Network error — are you online?');
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
    } catch { /* keep the status message */ }
    throw new Error(msg);
  }

  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    throw new Error('Unexpected response from server');
  }
  return res.json();
}

// ---------- Data loaders (REST first, direct Supabase as a fallback) ----------
async function loadCategories() {
  try {
    const data = await api('/categories');
    categories = Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[webview] /categories via API failed:', e && e.message);
    const client = getSupabaseClient();
    if (!client) { categories = []; }
    else {
      try {
        const { data } = await client.from('categories').select('*').eq('active', 1).order('sort_order');
        categories = data || [];
      } catch { categories = []; }
    }
  }
  renderCategories();
}

async function loadProducts() {
  try {
    const data = await api('/products');
    products = Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[webview] /products via API failed:', e && e.message);
    const client = getSupabaseClient();
    if (!client) { products = []; }
    else {
      try {
        const { data } = await client.from('products')
          .select('*, product_variants(*)')
          .eq('active', 1)
          .order('category_id, sort_order');
        products = (data || []).map((p) => ({ ...p, variants: p.product_variants || [] }));
      } catch { products = []; }
    }
  }
}

/** Normalize package payloads so every package has `slots` with `options` (name + photo). */
function normalizePackages(list) {
  return (list || []).map((pkg) => ({
    ...pkg,
    slots: (pkg.slots || pkg.package_slots || [])
      .slice()
      .sort((a, b) => (Number(a.slot_number) || 0) - (Number(b.slot_number) || 0))
      .map((slot) => {
        const options = (slot.options || slot.package_options || []).map((o) => ({
          ...o,
          name: (o.products && o.products.name) || o.name || 'Option',
          photo_url: (o.products && o.products.photo_url) || o.photo_url || null,
        }));
        return { ...slot, options };
      }),
  }));
}

async function loadPackages() {
  try {
    const data = await api('/packages');
    packages = normalizePackages(Array.isArray(data) ? data : []);
  } catch (e) {
    console.warn('[webview] /packages via API failed:', e && e.message);
    const client = getSupabaseClient();
    if (!client) { packages = []; }
    else {
      try {
        const { data } = await client.from('packages')
          .select('*, package_slots:package_slots(*, package_options:package_options(*, products(name, photo_url)))')
          .eq('active', 1)
          .order('id');
        packages = normalizePackages(data || []);
      } catch { packages = []; }
    }
  }
}

async function loadFoodPacks() {
  try {
    const data = await api('/food-packs');
    foodPacks = Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[webview] /food-packs via API failed:', e && e.message);
    const client = getSupabaseClient();
    if (!client) { foodPacks = []; }
    else {
      try {
        const { data } = await client.from('food_packs').select('*').eq('active', 1).order('sort_order');
        foodPacks = data || [];
      } catch { foodPacks = []; }
    }
  }
}

// ---------- Local cart (no DB round-trips) ----------
// The cart lives entirely in the webview (in-memory + localStorage) so adding
// items is instant. The server only sees the items at checkout, where every
// line is re-priced server-side from the DB — client totals are display-only.
const LOCAL_CART_KEY = () => 'webview_cart_' + sessionId;

function emptyCart() {
  return { items: [], nextId: 1, totals: { subtotal: 0, delivery: 0, discount: 0, total: 0, breakdown: [] } };
}

async function loadCart() {
  let saved = null;
  try { saved = JSON.parse(storageGet(LOCAL_CART_KEY()) || 'null'); } catch { saved = null; }
  cart = (saved && Array.isArray(saved.items)) ? saved : emptyCart();
  if (!Number.isFinite(cart.nextId)) cart.nextId = cart.items.reduce((m, i) => Math.max(m, Number(i.id) || 0), 0) + 1;
  recalcCartTotals();
  updateCartBadge();
}

function saveCart() {
  recalcCartTotals();
  storageSet(LOCAL_CART_KEY(), JSON.stringify(cart));
  updateCartBadge();
  refreshCartUI();
}

/** Display-name for a catalog-backed cart line. */
function cartItemName(kind, id, size) {
  if (kind === 'food_pack') {
    const fp = foodPacks.find((f) => Number(f.id) === Number(id));
    return (fp ? fp.name : 'Food pack') + ' (food pack)';
  }
  if (kind === 'package') {
    const pkg = packages.find((p) => Number(p.id) === Number(id));
    return (pkg ? pkg.name : 'Package') + ' (package)';
  }
  const p = products.find((x) => Number(x.id) === Number(id));
  return ((p ? p.name : 'Item') + ' ' + (size || '')).trim();
}

function localItemSignature(kind, id, size, choices) {
  const choiceKey = Array.isArray(choices)
    ? choices.map((c) => Number(c.slot_number) + ':' + Number(c.product_id) + ':' + (c.size || 'M')).sort().join('|')
    : '';
  return [kind, Number(id), size || '', choiceKey].join('~');
}

/** Add (or merge) an item into the local cart. Returns the cart item. */
function localAddItem(kind, id, quantity, size, slotChoices) {
  const qty = Math.max(1, Number(quantity) || 1);
  const sig = localItemSignature(kind, id, size, slotChoices);
  const existing = cart.items.find((it) => it._sig === sig);
  if (existing) {
    existing.quantity += qty;
    saveCart();
    return existing;
  }
  const item = {
    id: cart.nextId++,
    _sig: sig,
    name: cartItemName(kind, id, size),
    quantity: qty,
  };
  if (kind === 'product') item.product_id = Number(id);
  else if (kind === 'package') { item.package_id = Number(id); item.slot_choices = slotChoices || []; }
  else if (kind === 'food_pack') item.food_pack_id = Number(id);
  if (size) item.variant_size = size;
  cart.items.push(item);
  saveCart();
  return item;
}

/** Recompute display totals: every line is priced NET (package discount already
 *  applied and shown dashed on the item itself), so subtotal = total directly. */
function recalcCartTotals() {
  let subtotal = 0;
  let discount = 0;
  const breakdown = [];
  for (const it of cart.items) {
    const unit = cartItemNetUnitPrice(it);
    if (unit === null || unit === undefined) continue;
    const line = unit * it.quantity;
    subtotal += line;
    breakdown.push({ label: (it.name || 'Item') + ' x' + it.quantity, amount: line });
    if (it.package_id) {
      const gross = cartItemGrossUnitPrice(it);
      if (gross !== null && gross > unit + 0.001) discount += (gross - unit) * it.quantity;
    }
  }
  // Lines are already discounted — no separate deduction applied to the total.
  cart.totals = { subtotal, delivery: 0, discount, total: subtotal, breakdown };
}

function clearLocalCart() {
  cart = emptyCart();
  saveCart();
}

/** Re-render whatever cart surfaces are on screen (bar + cart view). */
function refreshCartUI() {
  renderCartBar();
  if (currentView === 'cart') showCart();
}

/** Render the store contact config into the header, disabled link, and menu "Visit us" card. */
function renderConfig() {
  const c = config.contact || {};
  const headerSub = $id('header-sub');
  if (headerSub) headerSub.textContent = c.hours || 'Order online';

  const strip = $id('contact-strip');
  const phoneLink = $id('contact-phone');
  const hoursEl = $id('contact-hours');
  if (strip) {
    let show = false;
    if (phoneLink && c.phone) {
      phoneLink.href = 'tel:' + c.phone;
      const span = $id('contact-phone-text');
      if (span) span.textContent = c.phone;
      show = true;
    }
    if (hoursEl && c.hours) {
      const span = $id('contact-hours-text');
      if (span) span.textContent = c.hours;
      show = true;
    }
    strip.style.display = show ? 'flex' : 'none';
  }

  const card = $id('store-info-card');
  const info = $id('store-info');
  if (card && info && (c.phone || c.email || c.address || c.hours)) {
    const rows = [];
    if (c.phone) rows.push(`<div>📞 <a href="tel:${esc(c.phone)}">${esc(c.phone)}</a></div>`);
    if (c.email) rows.push(`<div>✉️ <a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>`);
    if (c.address) rows.push(`<div>📍 ${esc(c.address)}</div>`);
    if (c.hours) rows.push(`<div>🕘 ${esc(c.hours)}</div>`);
    info.innerHTML = rows.join('');
    card.style.display = 'block';
  }
}

async function loadConfig() {
  config = { payment: {}, contact: {} };
  try {
    const data = await api('/config');
    if (data && data.payment) config.payment = data.payment;
    if (data && data.contact) config.contact = data.contact;
    // Capture the Google Maps API key sent by the server (from env GOOGLE_MAPS_API_KEY).
    if (data && data.mapsApiKey) serverMapsApiKey = String(data.mapsApiKey);
  } catch (e) {
    console.warn('[webview] /config failed:', e && e.message);
  }
  renderConfig();
  const link = $id('messenger-link-disabled');
  if (link) link.href = 'https://m.me/postrefoodproducts';
}

async function loadOrders() {
  try {
    const data = await api('/orders?session=' + sessionId);
    orders = Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[webview] /orders failed:', e && e.message);
    orders = [];
    throw e;
  }
}

// ---------- Categories ----------
function renderCategories() {
  // Category rail removed — customers now land on the packages-first home.
  renderCategorySections();
  // Wire up the packages promo banner at the top of the home.
  const promo = $id('cat-packages-promo');
  if (promo) {
    const sub = $id('packages-promo-sub');
    if (sub) sub.textContent = packages.length > 0
      ? packages.length + ' package' + (packages.length === 1 ? '' : 's') + ' — save more!'
      : 'Save more when you order combos';
    promo.style.display = packages.length > 0 ? 'block' : 'none';
  }
  const pp = $id('promo-packages');
  if (pp) pp.textContent = packages.length > 0
    ? packages.length + ' package' + (packages.length === 1 ? '' : 's') + ' available'
    : 'No packages right now';
  const pf = $id('promo-foodpacks');
  if (pf) pf.textContent = foodPacks.length > 0
    ? foodPacks.length + ' pack' + (foodPacks.length === 1 ? '' : 's') + ' available'
    : 'No food packs right now';
}

// ---------- Products ----------
function productVariants(p) {
  return (p && Array.isArray(p.variants)) ? p.variants : (p && Array.isArray(p.product_variants) ? p.product_variants : []);
}

/** Compact price label for a product card: single price or M–L range. */
function priceRange(p) {
  const vs = productVariants(p);
  if (vs.length === 0) return '';
  const prices = vs.map((v) => Number(v.price)).sort((a, b) => a - b);
  if (prices.length === 1) return formatMoney(prices[0]);
  return `${formatMoney(prices[0])} – ${formatMoney(prices[prices.length - 1])}`;
}

// Per-card size selections (persists while browsing): { 'product-12': 'L', 'package-3': 'M' }
const cardSizes = {};

/** Price label for a product card given a chosen size. */
function productCardPrice(p, size) {
  const vs = productVariants(p);
  const v = vs.find((x) => x.size === size) || vs[0];
  return v ? formatMoney(v.price) : priceRange(p);
}

/** Card price for a package at a size, using each slot's default dish (like the bot). */
function packageCardPrice(pkg, size) {
  const defaults = packageDefaultChoices(pkg);
  if (defaults.length === 0) return formatMoney(netPackagePrice(pkg));
  const choices = {};
  defaults.forEach((c) => { choices[c.slot_number] = c.product_id; });
  return formatMoney(pricePackageChoices(pkg, choices, size).total);
}

/** Default dish per slot for fixed packages (is_default wins, else first option). */
function packageDefaultChoices(pkg) {
  const out = [];
  for (const slot of (pkg.slots || [])) {
    const opts = packageSlotOptions(pkg, slot);
    const def = opts.find((o) => Number(o.is_default) === 1) || opts[0];
    if (def && def.product_id != null) out.push({ slot_number: Number(slot.slot_number), product_id: Number(def.product_id) });
  }
  return out;
}

/** Pick a size directly on a catalog card (updates the card price in place). */
function selectCardSize(event, kind, id, size) {
  if (event && event.stopPropagation) event.stopPropagation();
  cardSizes[kind + '-' + Number(id)] = size;
    const card = event && event.target ? event.target.closest('.product-card') : null;
  if (!card) return;
  card.querySelectorAll('.size-pill').forEach((b) => b.classList.toggle('selected', b.textContent.trim() === String(size)));
  const priceEl = card.querySelector('.card-price');
  if (priceEl) {
    if (kind === 'product') {
      const p = products.find((x) => Number(x.id) === Number(id));
      if (p) priceEl.textContent = productCardPrice(p, size);
    } else {
      const pkg = packages.find((x) => Number(x.id) === Number(id));
      if (pkg) priceEl.textContent = packageCardPrice(pkg, size);
    }
  }
}

/** Shared product card markup (category grid + "Popular right now" carousel).
 * extraCls adds a modifier class, e.g. 'fp-card' for the horizontal rail. */
function productCardHtml(p, extraCls) {
  const unavailable = Number(p.unavailable) === 1;
  const vs = productVariants(p);
  const selSize = cardSizes['product-' + p.id] || (vs[0] ? vs[0].size : null);
  // Sizes inline in the price row to save vertical space on the card.
  const sizePills = vs.length > 1
    ? vs.map((v) =>
        `<button class="size-pill${v.size === selSize ? ' selected' : ''}" onclick="selectCardSize(event, 'product', ${p.id}, '${esc(v.size)}')">${esc(v.size)}</button>`
      ).join('')
    : '';
  return `<div class="product-card${extraCls ? ' ' + extraCls : ''}${unavailable ? ' unavailable' : ''}" ${unavailable ? '' : `onclick="showProductDetail(${p.id})"`}>
    ${imageHtml(p.photo_url, p.name)}
    <div class="info">
      <div class="name">${esc(p.name)}</div>
      ${p.description ? `<div class="desc">${esc(p.description)}</div>` : ''}
      <div class="price-row">
        <span class="price card-price">${productCardPrice(p, selSize)}</span>
        ${sizePills ? `<span class="card-sizes card-sizes-inline">${sizePills}</span>` : ''}
      </div>
      ${unavailable ? '' : `<div class="card-actions"><button class="card-add-btn" onclick="addToCartProductQuick(${p.id}, event)">+ Add to Cart</button></div>`}
      ${unavailable ? '<span class="badge-flag">Unavailable</span>' : ''}
    </div>
  </div>`;
}

/** FoodPanda-style home: one horizontal dish carousel per menu category. */
function renderCategorySections() {
  const container = $id('category-sections');
  if (!container) return;
  const html = categories.map((c) => {
    const list = products.filter((p) => Number(p.category_id) === Number(c.id));
    if (list.length === 0) return '';
    // Cap the rail length — "See all" opens the full category grid.
    const cards = list.slice(0, 12).map((p) => productCardHtml(p, 'fp-card fp-card-sm')).join('');
    return `<div class="fp-section">
      <div class="fp-section-header">
        <div class="fp-section-title-row">
          <span class="fp-cat-label">${categoryIcon(c.name)} ${esc(c.name)}</span>
          <p class="fp-section-sub">${list.length} item${list.length === 1 ? '' : 's'}</p>
        </div>
        <button type="button" class="fp-see-all" onclick="showProducts(${c.id})">See all ›</button>
      </div>
      <div class="fp-rail fp-card-rail">${cards}</div>
    </div>`;
  }).join('');
  container.innerHTML = html || '<div class="empty-state"><div class="icon">🍽️</div><p>Menu items coming soon.</p></div>';
}

function showProducts(categoryId) {
  currentCategoryId = Number(categoryId);
  const cat = categories.find((c) => Number(c.id) === currentCategoryId);
  const list = products.filter((p) => Number(p.category_id) === currentCategoryId);
  $id('products-title').textContent = cat ? cat.name : 'Products';
  $id('products-sub').textContent = list.length + ' item' + (list.length === 1 ? '' : 's');

  const container = $id('products-list');
  if (list.length === 0) {
    container.innerHTML = products.length === 0
      ? `<div class="empty-state"><div class="icon">🍽️</div><p>Couldn't load the items. Check your connection and try again.</p></div>
         <button class="btn btn-primary" style="width:100%" onclick="retryProducts(${currentCategoryId})">Retry</button>`
      : '<div class="empty-state"><div class="icon">🍽️</div><p>No items in this category yet.</p></div>';
    showView('view-products');
    return;
  }

  container.innerHTML = list.map((p) => productCardHtml(p)).join('');
  showView('view-products');
}

async function retryProducts(categoryId) {
  showLoading('Loading items…');
  await loadProducts();
  hideLoading();
  showProducts(categoryId);
}

// ---------- Product detail ----------
function showProductDetail(productId) {
  const p = products.find((x) => Number(x.id) === Number(productId));
  if (!p) return;
  const vs = productVariants(p);
  productDetail = { productId: p.id, size: vs[0] ? vs[0].size : null, qty: 1 };
  renderProductDetail();
}

function currentProduct() {
  return products.find((x) => Number(x.id) === Number(productDetail.productId)) || null;
}

function selectedProductVariant() {
  const vs = productVariants(currentProduct());
  return vs.find((v) => v.size === productDetail.size) || vs[0] || null;
}

function renderProductDetail() {
  const p = currentProduct();
  if (!p) return;
  const vs = productVariants(p);
  const v = selectedProductVariant();
  const container = $id('product-detail');

  let variantsHtml = '';
  if (vs.length > 1) {
    variantsHtml = `<div class="variant-options">
      <label>Size:</label>
      ${vs.map((x) => `<button class="variant-btn${x.size === productDetail.size ? ' selected' : ''}" onclick="selectProductSize('${esc(x.size)}', this)">${esc(x.size)} — ${formatMoney(x.price)}</button>`).join('')}
    </div>`;
  }

  container.innerHTML = `
    ${imageHtml(p.photo_url, p.name, 'detail-image')}
    <div class="detail-name">${esc(p.name)}</div>
    <div class="detail-desc">${esc(p.description || '')}</div>
    ${variantsHtml}
    <div class="qty-selector">
      <button class="qty-btn" onclick="changeProductQty(-1)">−</button>
      <span class="qty-value" id="pd-qty">${productDetail.qty}</span>
      <button class="qty-btn" onclick="changeProductQty(1)">+</button>
    </div>
    <div class="price-total">${v ? formatMoney(v.price * productDetail.qty) : ''}</div>
    <button class="btn btn-primary btn-checkout" onclick="addToCartProduct()">Add to Cart</button>
  `;
  showView('view-product-detail');
}

function selectProductSize(size) {
  productDetail.size = size;
  renderProductDetail();
}

function changeProductQty(delta) {
  productDetail.qty = Math.max(1, productDetail.qty + delta);
  const qtyEl = $id('pd-qty');
  if (qtyEl) qtyEl.textContent = productDetail.qty;
  const v = selectedProductVariant();
  const container = $id('product-detail');
  if (container) {
    const totalEl = container.querySelector('.price-total');
    if (totalEl && v) totalEl.textContent = formatMoney(v.price * productDetail.qty);
  }
}

function addToCartProduct() {
  const v = selectedProductVariant();
  localAddItem('product', productDetail.productId, productDetail.qty, v ? v.size : null);
  showToast('Added to cart!');
}

// ---------- Packages (combos) ----------
function netPackagePrice(pkg) {
  return Math.max(0, (Number(pkg && pkg.base_price) || 0) - (Number(pkg && pkg.discount) || 0));
}

function showPackages() {
  const container = $id('packages-list');
  if (packages.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="icon">🎁</div><p>Couldn't load packages. Check your connection and try again.</p></div>
      <button class="btn btn-primary" style="width:100%" onclick="retryPackages()">Retry</button>`;
    showView('view-packages');
    return;
  }
  // All packages sorted by net price ascending (Build-Your-Own custom package,
  // if present, is treated like any other package and also sorted by price).
  const sorted = packages.slice().sort((a, b) => {
    const aCustom = !!(a && a.is_custom);
    const bCustom = !!(b && b.is_custom);
    const aPrice = netPackagePrice(a);
    const bPrice = netPackagePrice(b);
    if (aPrice !== bPrice) return aPrice - bPrice;
    // stable tie-break: custom packages sink to the bottom.
    if (aCustom !== bCustom) return aCustom ? 1 : -1;
    return 0;
  });
  // FoodPanda-style horizontal snap carousel (peek of the next package card).
  container.innerHTML = `<div class="fp-rail fp-card-rail">` + sorted.map((pkg) => {
    const saved = Number(pkg.discount) > 0;
    const selSize = cardSizes["package-" + pkg.id] || "M";

    // Preview of the dishes included (default picks) — up to 3, then "+N more".
    const names = pkg.is_custom
      ? []
      : (pkg.slots || []).map((slot) => {
          const opts = packageSlotOptions(pkg, slot);
          const def = opts.find((o) => Number(o.is_default) === 1) || opts[0];
          return def ? def.name : null;
        }).filter(Boolean);
    const dishPreview = names.length > 0
      ? `<div class="pkg-dishes">${esc(names.slice(0, 3).join(", "))}${names.length > 3 ? ` +${names.length - 3} more` : ""}</div>`
      : "";

    return `<div class="product-card fp-card fp-card-tall">
      ${imageHtml(pkg.photo_url, pkg.name)}
      <div class="info">
        <div class="name">${esc(pkg.name)}</div>
        ${pkg.description ? `<div class="desc">${esc(pkg.description)}</div>` : ""}
        ${dishPreview}
        <div class="price-line">
          ${saved ? `<span class="was">${formatMoney(pkg.base_price)}</span>` : ""}
          <span class="price card-price">${packageCardPrice(pkg, selSize)}</span>
          ${saved ? `<span class="save">Save ${formatMoney(pkg.discount)}</span>` : ""}
        </div>
        <div class="card-actions dual">
          <button class="card-add-btn" onclick="addToCartPackageQuick(${pkg.id}, event)">+ Add to Cart</button>
          <button class="card-add-btn btn-outline" onclick="event.stopPropagation(); showPackageDetail(${pkg.id})">Customize</button>
        </div>
      </div>
    </div>`;
  }).join('') + `</div>`;
  showView('view-packages');
}

async function retryPackages() {
  showLoading('Loading packages…');
  await loadPackages();
  hideLoading();
  showPackages();
}

/**
 * Options available for a package slot, with category attached.
 * - Fixed/preset packages: admin-defined option rows.
 * - Custom ("Build your own") packages: every active dish.
 */
function packageSlotOptions(pkg, slot) {
  if (!pkg.is_custom) {
    const opts = slot.options || [];
    const def = opts.find((o) => Number(o.is_default) === 1) || opts[0];
    const defPrice = def ? productMenuPriceM(def.product_id) : 0;
    return opts.map((o) => {
      const product = products.find((p) => Number(p.id) === Number(o.product_id));
      // Surcharge = price difference vs the slot's default dish (+ any admin
      // upgrade surcharge). The base price already covers the default dish, so
      // the total works out to sum(selected dish menu prices) − package
      // discount instead of double-counting full dish prices on top of base.
      const admin = Number(o.upgrade_price) > 0 ? Number(o.upgrade_price) : 0;
      const up = admin + Math.max(0, productMenuPriceM(o.product_id) - defPrice);
      return { ...o, upgrade_price: up, category_id: product ? product.category_id : null };
    });
  }
  // Custom packages: every active dish is allowed. Upgrade price comes from
  // admin-defined package_options when present; otherwise fall back to the dish's
  // M-size menu price so the total reacts when different dishes are chosen.
  const upgradePrices = new Map();
  const sizeUpgrades = new Map();
  for (const s of pkg.slots || []) {
    for (const o of s.options || []) {
      const pid = Number(o.product_id);
      if (Number(o.upgrade_price) > 0) upgradePrices.set(pid, Number(o.upgrade_price));
      if (Number(o.size_upgrade_price) > 0) sizeUpgrades.set(pid, Number(o.size_upgrade_price));
    }
  }
  return products
    .filter((p) => Number(p.unavailable) !== 1)
    .map((p) => {
      const pid = Number(p.id);
      const adminUpgrade = upgradePrices.get(pid);
      let up;
      if (adminUpgrade !== undefined) {
        up = adminUpgrade;
      } else {
        // No admin-configured upgrade: use the dish's M-size menu price so
        // the package total varies with the selected dish.
        up = productMenuPriceM(pid);
      }
      return {
        id: null,
        product_id: p.id,
        name: p.name,
        photo_url: p.photo_url,
        upgrade_price: up,
        size_upgrade_price: sizeUpgrades.get(pid) || 0,
        is_default: 0,
        category_id: p.category_id,
      };
    });
}

function showPackageDetail(pkgId) {
  const pkg = packages.find((x) => Number(x.id) === Number(pkgId));
  if (!pkg) return;
  const choices = {};
  if (!pkg.is_custom) {
    for (const slot of pkg.slots || []) {
      const options = packageSlotOptions(pkg, slot);
      const def = options.find((o) => Number(o.is_default) === 1) || options[0];
      if (def) choices[Number(slot.slot_number)] = Number(def.product_id);
    }
  }
  packageDetail = { pkgId: Number(pkg.id), choices, slotSizes: {}, size: cardSizes['package-' + Number(pkg.id)] || 'M', qty: 1 };
  renderPackageDetail();
}

function currentPackage() {
  return packages.find((x) => Number(x.id) === Number(packageDetail.pkgId)) || null;
}

  packages = packages.slice().sort((a, b) => (a.base_price || 0) - (b.base_price || 0));

/**
 * Auto-discount for "Build Your Own" custom packages, based on the sum of the
 * selected dishes' M-size menu prices (size upgrades excluded):
 *   sum >= 5000 → 1100, sum >= 4300 → 1000, sum >= 3000 → 700, else 0.
 * Mirrors the server's autoDiscount() so the displayed price equals checkout.
 */
function autoDiscount(itemsSum) {
  if (itemsSum >= 5000) return 1100;
  if (itemsSum >= 4300) return 1000;
  if (itemsSum >= 3000) return 700;
  return 0;
}

/** Client-side mirror of server pricing: base + slot upgrades (± per-slot size) − package discount.
 *  For custom "Build Your Own" packages, there is NO base price — the total is the
 *  sum of selected dish prices minus the tiered volume discount. */
function pricePackageChoices(pkg, choices, size, slotSizes) {
  const slots = (pkg.slots || []).slice().sort((a, b) => a.slot_number - b.slot_number);
  // Custom packages: no base price, total = sum of dish prices − volume discount
  let total = pkg.is_custom ? 0 : (Number(pkg.base_price) || 0);
  const lines = [];
  if (!pkg.is_custom) lines.push({ label: esc(pkg.name) + ' base', amount: total });
  let itemsSum = 0; // sum of selected dish M-prices (for custom auto-discount)
  for (const slot of slots) {
    const choice = choices[Number(slot.slot_number)];
    if (choice === undefined || choice === null) continue;
    const options = packageSlotOptions(pkg, slot);
    const opt = options.find((o) => Number(o.product_id) === Number(choice)) || null;
    const dishPrice = opt ? Number(opt.upgrade_price) || 0 : 0;
    let extra = dishPrice;
    const slotSize = (slotSizes && slotSizes[Number(slot.slot_number)]) || size;
    if (slotSize === 'L') {
      let sizeExtra = opt ? Number(opt.size_upgrade_price) || 0 : 0;
      if (!sizeExtra) sizeExtra = variantPriceDiff(choice);
      extra += sizeExtra;
    }
    if (pkg.is_custom) {
      // For custom packages, the upgrade_price IS the dish price (no base to add to)
      if (extra > 0) {
        total += extra;
        lines.push({ label: opt && opt.name, amount: extra });
      }
      // Track the dish's base price (excluding L upgrade) for volume discount
      if (dishPrice > 0) itemsSum += dishPrice;
    } else {
      if (extra > 0) {
        lines.push({ label: (opt && opt.name) + ' upgrade', amount: extra });
        total += extra;
      }
    }
  }
  // Custom ("Build Your Own") packages use a volume-based auto-discount;
  // fixed packages use the admin-set pkg.discount.
  const discount = pkg.is_custom ? autoDiscount(itemsSum) : Number(pkg.discount) || 0;
  if (discount > 0) {
    const applied = Math.min(discount, Math.max(0, total));
    lines.push({ label: pkg.is_custom ? 'Volume discount' : 'Package discount', amount: -applied });
    total = Math.max(0, total - applied);
  }
  return { total, lines };
}

/** Fallback Large-size upgrade = real menu price difference (L − M), like the server. */
function variantPriceDiff(productId) {
  const p = products.find((x) => Number(x.id) === Number(productId));
  const vs = p ? productVariants(p) : [];
  const l = vs.find((v) => String(v.size).toUpperCase() === 'L');
  const m = vs.find((v) => String(v.size).toUpperCase() === 'M');
  return Math.max(0, (Number(l && l.price) || 0) - (Number(m && m.price) || 0));
}

/**
 * A dish's M-size menu price (cheapest variant as fallback). Used as the
 * upgrade price for slot options the admin hasn't priced explicitly, so the
 * package total reacts when a different dish is selected in either kind of
 * package (fixed or custom).
 */
function productMenuPriceM(productId) {
  const p = products.find((x) => Number(x.id) === Number(productId));
  const vs = productVariants(p);
  const m = vs.find((v) => String(v.size).toUpperCase() === 'M') || vs[0];
  return Number(m && m.price) || 0;
}

/**
 * Category groups used to build a slot's menu from its default dish.
 * Keywords match database category names (case-insensitive substring).
 */
const SLOT_CATEGORY_GROUPS = [
  { name: 'Chicken', keywords: ['chicken'] },
  { name: 'Pork/Beef/Seafood', keywords: ['pork', 'beef', 'seafood'] },
  { name: 'Pasta/Vegetables', keywords: ['pasta', 'noodle', 'vegetable', 'veggie'] },
  { name: 'Desserts', keywords: ['dessert'] },
];

/** Lowercase category name of a product ('' when unknown). */
function productCategoryName(productId) {
  const product = products.find((p) => Number(p.id) === Number(productId));
  if (!product) return '';
  const cat = categories.find((c) => Number(c.id) === Number(product.category_id));
  return cat ? String(cat.name || '').toLowerCase() : '';
}

/** Group a category name belongs to (null when it matches no group). */
function categoryGroupFor(catName) {
  if (!catName) return null;
  return SLOT_CATEGORY_GROUPS.find((g) => g.keywords.some((kw) => catName.includes(kw))) || null;
}

/**
 * The category group a slot's menu is built from, derived from the slot's
 * default (admin-assigned) dish: chicken default → all chicken, pork/beef/
 * seafood default → pork/beef/seafood, pasta default → pasta/noodles/
 * vegetables, dessert default → desserts. Slots without a usable default
 * (custom packages) fall back to position rules.
 */
function slotGroupFor(pkg, slot, totalSlots) {
  const options = packageSlotOptions(pkg, slot);
  const def = options.find((o) => Number(o.is_default) === 1) || options[0];
  if (def) {
    const group = categoryGroupFor(productCategoryName(def.product_id));
    if (group) return group;
  }
  const n = Number(slot.slot_number);
  if (n === 1) return SLOT_CATEGORY_GROUPS[0];
  if (totalSlots > 0 && n === totalSlots) return SLOT_CATEGORY_GROUPS[3];
  if (totalSlots > 0 && n === totalSlots - 1) return SLOT_CATEGORY_GROUPS[2];
  return SLOT_CATEGORY_GROUPS[1];
}

/** Keep only options whose product's category belongs to the group. */
function filterOptionsByGroup(options, group) {
  if (!group) return options;
  const filtered = options.filter(
    (opt) => categoryGroupFor(productCategoryName(opt.product_id)) === group
  );
  return filtered.length > 0 ? filtered : options;
}

function renderPackageDetail() {
  const pkg = currentPackage();
  if (!pkg) return;
  const container = $id('package-detail');
  const slots = (pkg.slots || []).slice().sort((a, b) => a.slot_number - b.slot_number);
  const chosen = Object.keys(packageDetail.choices).length;
  const needed = Number(pkg.selections) || slots.length || 0;
  const complete = pkg.is_custom ? chosen >= Math.max(4, needed) : chosen >= needed;
  const pricing = pricePackageChoices(pkg, packageDetail.choices, packageDetail.size, packageDetail.slotSizes);

  let slotsHtml = '';
  if (pkg.is_custom) {
    slotsHtml = renderByopCustom(pkg, slots, Math.max(4, needed), complete);
  } else if (slots.length > 0) {
    slotsHtml = renderFixedSlots(pkg, slots);
  } else {
    slotsHtml = '<div class="empty-state"><div class="icon">🥡</div><p>This package has no dish slots defined.</p></div>';
  }

  // For custom packages, calculate discount to show dashed original total
  let discountLine = '';
  if (pkg.is_custom) {
    const slots = (pkg.slots || []).slice().sort((a, b) => a.slot_number - b.slot_number);
    let itemsSum = 0;
    for (const slot of slots) {
      const choice = packageDetail.choices[Number(slot.slot_number)];
      if (choice !== undefined && choice !== null) {
        itemsSum += productMenuPriceM(Number(choice));
      }
    }
    const discount = autoDiscount(itemsSum);
    if (discount > 0) {
      const grossTotal = pricing.total + discount;
      discountLine = `<div class="pkg-discount-line">
        <span class="was">${formatMoney(grossTotal * packageDetail.qty)}</span>
        <span class="discount-amt">−${formatMoney(discount * packageDetail.qty)}</span>
      </div>`;
    }
  }

  container.innerHTML = `
    ${imageHtml(pkg.photo_url, pkg.name, 'detail-image')}
    <div class="detail-name">${esc(pkg.name)}</div>
    <div class="detail-desc">${esc(pkg.description || '')}</div>
    ${pkg.is_custom ? '' : `<div class="pkg-price-line compact">
      ${Number(pkg.discount) > 0 ? `<span class="was">${formatMoney(pkg.base_price)}</span>` : ''}
      <span class="price">${formatMoney(netPackagePrice(pkg))}</span>
      ${Number(pkg.discount) > 0 ? `<span class="save">Save ${formatMoney(pkg.discount)}</span>` : ''}
    </div>`}
    ${slotsHtml}
    <div class="variant-options">
      <label>Size:</label>
      <button class="variant-btn${packageDetail.size === 'M' ? ' selected' : ''}" onclick="selectPackageSize('M', this)">M</button>
      <button class="variant-btn${packageDetail.size === 'L' ? ' selected' : ''}" onclick="selectPackageSize('L', this)">L</button>
    </div>
    <div class="qty-selector">
      <button class="qty-btn" onclick="changePackageQty(-1)">−</button>
      <span class="qty-value" id="pkg-qty">${packageDetail.qty}</span>
      <button class="qty-btn" onclick="changePackageQty(1)">+</button>
    </div>
    ${discountLine}
    <div class="price-total" id="pkg-price-total">${formatMoney(pricing.total * packageDetail.qty)}</div>
    <button class="btn btn-primary btn-checkout" onclick="addToCartPackage()" ${complete ? '' : 'disabled'}>
      ${complete ? 'Add to Cart' : `Choose ${needed} dishes (${chosen}/${needed})`}
    </button>
  `;
  showView('view-package');
}

/** Render the "Build Your Own" custom package: selected items + full menu grid.
 *  No maximum slot limit — customer can add as many dishes as they want (minimum 4). */
function renderByopCustom(pkg, slots, needed, complete) {
  const selectedSlots = slots.map((slot) => {
    const pid = packageDetail.choices[Number(slot.slot_number)];
    if (pid === undefined || pid === null) return null;
    const product = products.find((p) => Number(p.id) === Number(pid));
    if (!product) return null;
    const cat = categories.find((c) => Number(c.id) === Number(product.category_id));
    return { slotNumber: slot.slot_number, productId: pid, name: product.name, photo: product.photo_url, category: cat ? cat.name : '' };
  }).filter(Boolean);

  const selectedHtml = selectedSlots.length > 0
    ? `<div class="byop-selected">
        <h4>Your Selection (${selectedSlots.length} dishes${needed > 0 ? ` — min ${needed}` : ''})</h4>
        <div class="byop-selected-list">
          ${selectedSlots.map((s) => `
            <div class="byop-selected-item">
              ${s.photo ? `<img class="byop-sel-thumb img-skel" src="${esc(absUrl(s.photo))}" loading="lazy" onload="this.classList.remove('img-skel')" onerror="this.remove()">` : ''}
              <div class="byop-sel-info">
                <span class="byop-sel-cat">${esc(s.category)}</span>
                <span class="byop-sel-name">${esc(s.name)}</span>
              </div>
              <button class="byop-sel-remove" onclick="removeFromSlot(${s.slotNumber})" title="Remove">✕</button>
            </div>`).join('')}
        </div>
      </div>`
    : '';

  const menuItems = products.filter((p) => Number(p.unavailable) !== 1);
  const itemsByCategory = {};
  for (const p of menuItems) {
    const cat = categories.find((c) => Number(c.id) === Number(p.category_id));
    const catName = cat ? cat.name : 'Other';
    if (!itemsByCategory[catName]) itemsByCategory[catName] = [];
    itemsByCategory[catName].push(p);
  }

  const selectedPids = selectedSlots.map((s) => s.productId);
  const menuHtml = Object.keys(itemsByCategory).sort().map((catName) => {
    const items = itemsByCategory[catName];
    return `<div class="byop-category">
      <div class="byop-cat-header">${esc(catName)}</div>
      <div class="byop-btn-grid">
        ${items.map((p) => {
          const pid = Number(p.id);
          const isSelected = selectedPids.includes(pid);
          const upgrade = productMenuPriceM(pid);
          return `<button class="byop-btn${isSelected ? ' selected' : ''}" onclick="addToSlot(${pid})">
            ${esc(p.name)}${upgrade > 0 ? ` <em>+${formatMoney(upgrade)}</em>` : ''}
          </button>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');

  return `${selectedHtml}<div class="byop-menu"><h4>Add dishes (min ${needed})</h4>${menuHtml}</div>`;
}

/** Render fixed-package slot options (unchanged behavior). */
function renderFixedSlots(pkg, slots) {
  return slots.map((slot) => {
    const allOptions = packageSlotOptions(pkg, slot);
    const group = slotGroupFor(pkg, slot, slots.length);
    const options = filterOptionsByGroup(allOptions, group);
    if (options.length === 0) return '';
    const cur = packageDetail.choices[Number(slot.slot_number)];
    const slotSize = packageDetail.slotSizes[Number(slot.slot_number)] || packageDetail.size;
    const sizeUpgrade = (() => {
      if (cur === undefined || cur === null) return 0;
      const opt = options.find((o) => Number(o.product_id) === Number(cur));
      let up = opt ? Number(opt.size_upgrade_price) || 0 : 0;
      if (!up) up = variantPriceDiff(cur);
      return up;
    })();
    return `<div class="package-slot">
      <div class="slot-header">
        <h4>${esc(group.name)}</h4>
        <div class="slot-size-toggle">
          <span class="slot-size-label">Size:</span>
          <button class="slot-size-btn${slotSize === 'M' ? ' selected' : ''}" onclick="selectPackageSlotSize(event, ${slot.slot_number}, 'M')">M</button>
          <button class="slot-size-btn${slotSize === 'L' ? ' selected' : ''}" onclick="selectPackageSlotSize(event, ${slot.slot_number}, 'L')">L${sizeUpgrade > 0 ? ` <em>+${formatMoney(sizeUpgrade)}</em>` : ''}</button>
        </div>
      </div>
      <div class="slot-options">
        ${options.map((opt) => {
          const selected = cur !== undefined && cur !== null && Number(cur) === Number(opt.product_id);
          const upgrade = Number(opt.upgrade_price) || 0;
          const thumb = opt.photo_url
            ? `<img class="opt-thumb img-skel" src="${esc(absUrl(opt.photo_url))}" alt="" title="View photo" loading="lazy" onload="this.classList.remove('img-skel')" onclick="openImageLightbox(event, '${esc(absUrl(opt.photo_url))}', '${esc(opt.name)}')" onerror="this.remove()">`
            : '';
          return `<span class="slot-option${selected ? ' selected' : ''}" onclick="selectPackageSlot(${slot.slot_number}, ${opt.product_id})">
            ${thumb}${esc(opt.name)}${upgrade > 0 ? ` <em>+${formatMoney(upgrade)}</em>` : ''}
          </span>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');
}

/** Add a dish to the next available slot (custom package). No max limit. */
function addToSlot(productId) {
  const pkg = currentPackage();
  if (!pkg || !pkg.is_custom) return;
  const slots = (pkg.slots || []).slice().sort((a, b) => a.slot_number - b.slot_number);
  // Find the first empty slot
  for (const slot of slots) {
    const sn = Number(slot.slot_number);
    if (packageDetail.choices[sn] === undefined || packageDetail.choices[sn] === null) {
      packageDetail.choices[sn] = productId;
      break;
    }
  }
  renderPackageDetail();
}

/** Remove a dish from its slot (custom package). */
function removeFromSlot(slotNumber) {
  const pkg = currentPackage();
  if (!pkg || !pkg.is_custom) return;
  delete packageDetail.choices[Number(slotNumber)];
  renderPackageDetail();
}

/** Upgrade a single slot to M or L (re-renders the detail view). */
function selectPackageSlotSize(event, slotNumber, size) {
  if (event && event.stopPropagation) event.stopPropagation();
  packageDetail.slotSizes[Number(slotNumber)] = size;
  renderPackageDetail();
}

function selectPackageSlot(slotNumber, productId) {
  // Update the choice for this slot
  packageDetail.choices[slotNumber] = productId;
  // Re-render the entire detail view so the total, counter, button, and
  // per-slot L-button upgrade prices all recalculate consistently.
  renderPackageDetail();
}

function selectPackageSize(size) {
  packageDetail.size = size;
  renderPackageDetail();
}

function changePackageQty(delta) {
  packageDetail.qty = Math.max(1, packageDetail.qty + delta);
  const qtyEl = $id('pkg-qty');
  if (qtyEl) qtyEl.textContent = packageDetail.qty;
  const pkg = currentPackage();
  if (!pkg) return;
  const pricing = pricePackageChoices(pkg, packageDetail.choices, packageDetail.size, packageDetail.slotSizes);
  const totalEl = $id('package-detail').querySelector('.price-total');
  if (totalEl) {
    totalEl.textContent = formatMoney(pricing.total * packageDetail.qty);
    totalEl.classList.remove('flash');
    void totalEl.offsetWidth;
    totalEl.classList.add('flash');
  }
}

function addToCartPackage() {
  const pkg = currentPackage();
  if (!pkg) return;
  const needed = Number(pkg.selections) || (pkg.slots || []).length || 0;
  if (Object.keys(packageDetail.choices).length < needed) {
    return showToast(`Please choose ${needed} dishes first`);
  }
  const slotChoices = Object.keys(packageDetail.choices).map((slot) => ({
    slot_number: Number(slot),
    product_id: Number(packageDetail.choices[slot]),
    size: packageDetail.slotSizes[Number(slot)] || packageDetail.size,
  }));
  localAddItem('package', packageDetail.pkgId, packageDetail.qty, packageDetail.size, slotChoices);
  showToast('Added to cart!');
}

/** Quick add from a product card: selected size, qty 1, no round-trip. */
function addToCartProductQuick(productId, event) {
  if (event && event.stopPropagation) event.stopPropagation();
  const p = products.find((x) => Number(x.id) === Number(productId));
  if (!p) return;
  const vs = productVariants(p);
  const size = cardSizes['product-' + Number(productId)] || (vs[0] ? vs[0].size : null);
  localAddItem('product', productId, 1, size);
  showToast('Added to cart!');
}

/** Quick add from a package card: fixed packages add with default dishes; custom opens the chooser. */
function addToCartPackageQuick(pkgId, event) {
  if (event && event.stopPropagation) event.stopPropagation();
  const pkg = packages.find((x) => Number(x.id) === Number(pkgId));
  if (!pkg) return;
  if (pkg.is_custom) return showPackageDetail(pkgId);
  const choices = packageDefaultChoices(pkg);
  const needed = Number(pkg.selections) || (pkg.slots || []).length || 0;
  if (needed > 0 && choices.length < needed) return showPackageDetail(pkgId);
  const size = cardSizes['package-' + Number(pkgId)] || 'M';
  localAddItem('package', pkgId, 1, size, choices);
  showToast('Added to cart!');
}

// ---------- Food Packs ----------
function showFoodPacks() {
  const container = $id('food-packs-list');
  if (foodPacks.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="icon">🍱</div><p>Couldn't load food packs. Check your connection and try again.</p></div>
      <button class="btn btn-primary" style="width:100%" onclick="retryFoodPacks()">Retry</button>`;
    showView('view-food-packs');
    return;
  }
  // FoodPanda-style horizontal snap carousel (peek of the next food pack).
  container.innerHTML = `<div class="fp-rail fp-card-rail">` + foodPacks.map((fp) => `
    <div class="product-card fp-card" onclick="showFoodPackDetail(${fp.id})">
      ${imageHtml(fp.photo_url, fp.name)}
      <div class="info">
        <div class="name">${esc(fp.name)}</div>
        ${fp.description ? `<div class="desc">${esc(fp.description)}</div>` : ''}
        ${fp.serves ? `<div class="serves">Serves ${esc(fp.serves)}</div>` : ''}
        <div class="price">${formatMoney(fp.price)}</div>
      </div>
    </div>`).join('') + `</div>`;
  showView('view-food-packs');
}

async function retryFoodPacks() {
  showLoading('Loading food packs…');
  await loadFoodPacks();
  hideLoading();
  showFoodPacks();
}

// ---------- Food Pack detail (pieces input, min 10) ----------
function currentFoodPack() {
  return foodPacks.find((x) => Number(x.id) === Number(foodPackDetail.fpId)) || null;
}

function showFoodPackDetail(fpId) {
  const fp = foodPacks.find((x) => Number(x.id) === Number(fpId));
  if (!fp) return;
  foodPackDetail = { fpId: Number(fp.id), pieces: FOOD_PACK_MIN_PIECES };
  renderFoodPackDetail();
}

function renderFoodPackDetail() {
  const fp = currentFoodPack();
  if (!fp) return;
  const container = $id('food-pack-detail');
  container.innerHTML = `
    ${imageHtml(fp.photo_url, fp.name, 'detail-image')}
    <div class="detail-name">${esc(fp.name)}</div>
    <div class="detail-desc">${esc(fp.description || '')}</div>
    ${fp.serves ? `<div class="serves">Serves ${esc(fp.serves)}</div>` : ''}
    <div class="pkg-price-line compact">
      <span class="price">${formatMoney(fp.price)}</span>
      <span class="per-piece">per piece</span>
    </div>
    <label class="pieces-label">Pieces:</label>
    <div class="qty-selector">
      <button class="qty-btn" onclick="changeFoodPackPieces(-1)">−</button>
      <input type="number" class="pieces-input" id="fp-pieces" min="${FOOD_PACK_MIN_PIECES}" value="${foodPackDetail.pieces}" oninput="setFoodPackPieces(this.value)">
      <button class="qty-btn" onclick="changeFoodPackPieces(1)">+</button>
    </div>
    <div class="min-hint">Minimum of ${FOOD_PACK_MIN_PIECES} pieces</div>
    <div class="price-total" id="fp-total">${formatMoney(fp.price * foodPackDetail.pieces)}</div>
    <button class="btn btn-primary btn-checkout" onclick="addToCartFoodPack()">Add to Cart</button>
  `;
  showView('view-food-pack-detail');
}

/** Set pieces from the number input; clamps to the minimum. */
function setFoodPackPieces(value) {
  const n = Math.max(FOOD_PACK_MIN_PIECES, Math.floor(Number(value) || 0));
  foodPackDetail.pieces = n;
  const input = $id('fp-pieces');
  if (input && Number(value) !== n) input.value = n;
  updateFoodPackTotal();
}

/** ± stepper for the pieces input; clamps to the minimum. */
function changeFoodPackPieces(delta) {
  foodPackDetail.pieces = Math.max(FOOD_PACK_MIN_PIECES, foodPackDetail.pieces + delta);
  const input = $id('fp-pieces');
  if (input) input.value = foodPackDetail.pieces;
  updateFoodPackTotal();
}

/** Reactive total = price per piece × pieces (with flash). */
function updateFoodPackTotal() {
  const fp = currentFoodPack();
  if (!fp) return;
  const totalEl = $id('fp-total');
  if (totalEl) {
    totalEl.textContent = formatMoney(fp.price * foodPackDetail.pieces);
    totalEl.classList.remove('flash');
    void totalEl.offsetWidth;
    totalEl.classList.add('flash');
  }
}

function addToCartFoodPack() {
  const fp = currentFoodPack();
  if (!fp) return;
  if (foodPackDetail.pieces < FOOD_PACK_MIN_PIECES) {
    return showToast(`Minimum of ${FOOD_PACK_MIN_PIECES} pieces required`);
  }
  localAddItem('food_pack', foodPackDetail.fpId, foodPackDetail.pieces);
  showToast('Added to cart!');
}

// ---------- Fixed cart bar (toggled) - DISABLED ----------
const CART_BAR_HIDDEN_VIEWS = ['cart', 'checkout', 'orders', 'order-detail', 'success'];
let cartBarOpen = false;

function toggleCartBar() {
  // Floating cart bar removed - do nothing
}

function checkoutFromCartBar() {
  // Floating cart bar removed - do nothing
}

/** Renders the fixed bottom bar - DISABLED: floating cart removed. */
function renderCartBar() {
  // Floating cart bar removed - always hide
  const bar = $id('cart-bar');
  const app = $id('app');
  if (bar) bar.classList.add('hidden');
  if (app) app.classList.remove('has-cart-bar');
}

// ---------- Cart ----------
/** Best-effort unit price for a cart item, computed from the loaded catalog. */
function cartItemUnitPrice(item) {
  if (item.food_pack_id) {
    const fp = foodPacks.find((f) => Number(f.id) === Number(item.food_pack_id));
    return fp ? Number(fp.price) || 0 : null;
  }
  if (item.package_id) {
    const pkg = packages.find((p) => Number(p.id) === Number(item.package_id));
    if (!pkg) return null;
    const choices = {};
    const slotSizes = {};
    (item.slot_choices || []).forEach((c) => {
      choices[Number(c.slot_number)] = Number(c.product_id);
      if (c.size) slotSizes[Number(c.slot_number)] = c.size;
    });
    // GROSS (pre-discount) unit price: the cart lists every menu item at its
    // full price and shows the package discount as a separate deduction
    // (subtotal − discount = total). pricePackageChoices returns the net total
    // plus a negative "Package discount" line — add the discount back.
    const priced = pricePackageChoices(pkg, choices, item.variant_size, slotSizes);
    const pkgDiscount = (priced.lines || [])
      .filter((l) => Number(l.amount) < 0)
      .reduce((s, l) => s + Math.abs(Number(l.amount)), 0);
    return priced.total + pkgDiscount;
  }
  if (item.product_id) {
    const p = products.find((x) => Number(x.id) === Number(item.product_id));
    const vs = p ? productVariants(p) : [];
    const v = vs.find((x) => x.size === item.variant_size) || vs[0];
    return v ? Number(v.price) || 0 : null;
  }
  return null;
}

/** Net (discounted) unit price for a cart line — what the customer actually pays. */
function cartItemNetUnitPrice(item) {
  return cartItemUnitPrice(item);
}

/** Gross (pre-discount) unit price for a cart line — used for the struck-through "was" price. */
function cartItemGrossUnitPrice(item) {
  if (item.package_id) {
    const pkg = packages.find((p) => Number(p.id) === Number(item.package_id));
    if (!pkg) return null;
    // Fixed packages: only show "was" when an admin-set discount exists.
    // Custom packages: the auto-discount may apply (checked below via breakdown).
    if (!pkg.is_custom && !(Number(pkg.discount) > 0)) return null;
    const choices = {};
    const slotSizes = {};
    (item.slot_choices || []).forEach((c) => {
      choices[Number(c.slot_number)] = Number(c.product_id);
      if (c.size) slotSizes[Number(c.slot_number)] = c.size;
    });
    const priced = pricePackageChoices(pkg, choices, item.variant_size, slotSizes);
    const discount = (priced.lines || [])
      .filter((l) => Number(l.amount) < 0)
      .reduce((s, l) => s + Math.abs(Number(l.amount)), 0);
    return discount > 0 ? priced.total + discount : null;
  }
  return null;
}

/** Net (post-discount) unit price for a cart line — what the line actually costs. */
function cartItemNetUnitPrice(item) {
  if (item.package_id) {
    const pkg = packages.find((p) => Number(p.id) === Number(item.package_id));
    if (!pkg) return null;
    const choices = {};
    const slotSizes = {};
    (item.slot_choices || []).forEach((c) => {
      choices[Number(c.slot_number)] = Number(c.product_id);
      if (c.size) slotSizes[Number(c.slot_number)] = c.size;
    });
    return pricePackageChoices(pkg, choices, item.variant_size, slotSizes).total;
  }
  return cartItemUnitPrice(item);
}

/** Composition text for package cart items, e.g. "Chicken (L), Pancit Bam-i". */
function slotChoiceText(item) {
  if (!Array.isArray(item.slot_choices) || item.slot_choices.length === 0) return '';
  return item.slot_choices.map((c) => {
    const p = products.find((x) => Number(x.id) === Number(c.product_id));
    const name = p ? p.name : 'Item #' + c.product_id;
    return c.size === 'L' ? `${name} (L)` : name;
  }).join(', ');
}

function showCart() {
  const container = $id('cart-items');
  const sub = $id('cart-sub');
  if (sub) sub.textContent = cart.items.length + ' item' + (cart.items.length === 1 ? '' : 's') + ' in your cart';

  if (cart.items.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="icon">🛒</div><p>Your cart is empty</p></div>';
  } else {
    container.innerHTML = cart.items.map((item) => {
      const netUnit = cartItemNetUnitPrice(item);
      const grossUnit = cartItemGrossUnitPrice(item);
      const line = netUnit !== null && netUnit !== undefined ? netUnit * item.quantity : null;
      const composition = slotChoiceText(item);
      // Show the ALREADY-DISCOUNTED price; the pre-discount price is dashed next to it.
      const perLine = netUnit !== null && netUnit !== undefined
        ? `<span class="price-line-unit">${formatMoney(netUnit)} × ${item.quantity}</span>`
        : `<span class="price-line-cart">Qty: ${item.quantity}</span>`;
      const wasHtml = (grossUnit !== null && netUnit !== null && grossUnit > netUnit + 0.001)
        ? `<span class="price-was">${formatMoney(grossUnit)}</span>`
        : '';
      const lineTotal = line !== null
        ? `<span class="price-line-total">${formatMoney(line)}</span>`
        : '';
      return `<div class="cart-item">
        <div class="item-info">
          <div class="item-name">${esc(item.name)}${wasHtml}</div>
          ${composition ? `<div class="item-meta">${esc(composition)}</div>` : ''}
          <div class="price-line-row">${perLine}${lineTotal}</div>
        </div>
        <div class="qty-controls">
          <button onclick="updateCartItem(${item.id}, ${item.quantity - 1})" aria-label="Decrease quantity">−</button>
          <button onclick="updateCartItem(${item.id}, ${item.quantity + 1})" aria-label="Increase quantity">+</button>
        </div>
        <button class="remove-btn" onclick="removeCartItem(${item.id})" aria-label="Remove item">🗑️</button>
      </div>`;
    }).join('');
  }

  const totals = $id('cart-totals');
  const t = cart.totals || {};
  const breakdown = Array.isArray(t.breakdown) ? t.breakdown : [];
  let lines = '';
  for (const b of breakdown) {
    const neg = Number(b.amount) < 0;
    lines += `<div class="total-row line-item"><span>${esc(b.label)}</span><span>${neg ? '−' : ''}${formatMoney(Math.abs(b.amount))}</span></div>`;
  }
  lines += `<div class="total-row"><span>Subtotal${cart.items.length > 0 ? ` (${cart.items.reduce((s, i) => s + i.quantity, 0)} item${cart.items.reduce((s, i) => s + i.quantity, 0) === 1 ? '' : 's'})` : ''}</span><span>${formatMoney(t.subtotal)}</span></div>`;
  if (Number(t.discount) > 0) lines += `<div class="total-row discount"><span>Package Savings (already applied)</span><span>−${formatMoney(t.discount)}</span></div>`;
  lines += `<div class="total-row"><span>Delivery</span><span>${Number(t.delivery) > 0 ? formatMoney(t.delivery) : 'To be decided'}</span></div>`;
  lines += `<div class="total-row grand"><span>Total</span><span class="value">${formatMoney(t.total)}</span></div>`;
  totals.innerHTML = lines;

  const checkoutBtn = $id('checkout-btn');
  if (checkoutBtn) {
    checkoutBtn.disabled = cart.items.length === 0;
    checkoutBtn.textContent = cart.items.length === 0 ? 'Cart is empty' : 'Proceed to Checkout';
  }
  showView('view-cart');
}

/** Local-cart quantity change (no server round-trip). */
function updateCartItem(itemId, qty) {
  const it = cart.items.find((x) => Number(x.id) === Number(itemId));
  if (!it) return;
  const next = Number(qty) || 0;
  if (next <= 0) return removeCartItem(itemId);
  // Food packs keep the per-piece minimum even when edited in the cart.
  if (it.food_pack_id && next < FOOD_PACK_MIN_PIECES) {
    it.quantity = FOOD_PACK_MIN_PIECES;
    showToast(`Minimum of ${FOOD_PACK_MIN_PIECES} pieces for food packs`);
  } else {
    it.quantity = next;
  }
  saveCart();
}

/** Local-cart removal (no server round-trip). */
function removeCartItem(itemId) {
  cart.items = cart.items.filter((x) => Number(x.id) !== Number(itemId));
  saveCart();
}

// ---------- Navigation ----------
function showCategories() {
  showView('view-categories');
}

// ---------- Checkout ----------
const CUSTOMER_DATA_KEY = () => 'webview_customer_' + sessionId;

/** Save customer data to localStorage for next order. */
function saveCustomerData(name, phone, address) {
  try {
    localStorage.setItem(CUSTOMER_DATA_KEY(), JSON.stringify({ name, phone, address }));
  } catch { /* non-fatal */ }
}

/** Load remembered customer data from localStorage. */
function loadCustomerData() {
  try {
    const data = localStorage.getItem(CUSTOMER_DATA_KEY());
    return data ? JSON.parse(data) : null;
  } catch { return null; }
}

function startCheckout() {
  if (cart.items.length === 0) return showToast('Your cart is empty');
  const container = $id('checkout-form');
  if (!container) return;

  // Load remembered customer data + the location confirmed at the gate
  const remembered = loadCustomerData();
  const savedLoc = getSavedLocation();

  const pay = config.payment || {};
  const methods = [
    { id: 'cod', label: 'Cash on Delivery', desc: pay.cod || 'Pay in cash when your order arrives.' },
    { id: 'gcash', label: 'GCash', desc: pay.gcash || 'Pay via GCash.' },
    { id: 'bank', label: 'Bank Transfer', desc: pay.bank || 'Pay via bank transfer.' },
  ];

  container.innerHTML = `
    <div class="form-group">
      <label>Full Name</label>
      <input type="text" id="co-name" placeholder="Juan Dela Cruz" value="${esc(remembered?.name || '')}">
    </div>
    <div class="form-group">
      <label>Order Type</label>
      <select id="order-type">
        <option value="delivery">Delivery</option>
        <option value="pickup">Pickup</option>
      </select>
    </div>
    <div class="form-group" id="address-group">
      <label>Delivery Address</label>
      <textarea id="address" placeholder="House #, street, barangay, city">${esc(remembered?.address || (savedLoc && savedLoc.address) || '')}</textarea>
    </div>
    <div class="form-group">
      <label>Contact Number</label>
      <input type="tel" id="phone" placeholder="09XX-XXX-XXXX" value="${esc(remembered?.phone || '')}">
    </div>
    <div class="form-group">
      <label>Fulfillment Date</label>
      <input type="date" id="fulfill-date">
    </div>
    <div class="form-group">
      <label>Time Slot</label>
      <select id="time-slot"><option value="">Select a date first</option></select>
    </div>
    <div class="form-group">
      <label>Payment Method</label>
      ${methods.map((m, i) => `
        <div class="payment-option${i === 0 ? ' selected' : ''}" onclick="selectPayment('${m.id}', this)">
          <input type="radio" name="payment" value="${m.id}"${i === 0 ? ' checked' : ''}> ${esc(m.label)}
        </div>`).join('')}
    </div>
    <div id="payment-info" class="detail-desc">${esc(methods[0].desc)}</div>
    <div class="form-group">
      <label>Notes (optional)</label>
      <textarea id="notes" placeholder="Landmarks, delivery instructions…"></textarea>
    </div>
    <div class="total-row grand" style="margin:12px 0"><span>Order Total</span><span class="value">${formatMoney(cart.totals.total)}</span></div>
    <button class="btn btn-primary btn-checkout" id="place-order-btn" onclick="placeOrder()">Place Order</button>
  `;

  $id('order-type').addEventListener('change', function () {
    $id('address-group').style.display = this.value === 'delivery' ? 'block' : 'none';
  });
  $id('fulfill-date').addEventListener('change', function () { loadTimeSlots(this.value); });

  const today = new Date().toISOString().split('T')[0];
  $id('fulfill-date').setAttribute('min', today);
  showView('view-checkout');
}

function selectPayment(method, el) {
  document.querySelectorAll('.payment-option').forEach((p) => p.classList.remove('selected'));
  el.classList.add('selected');
  const input = el.querySelector('input');
  if (input) input.checked = true;
  const info = $id('payment-info');
  if (info) info.textContent = (config.payment || {})[method] || '';
}

/** Load the reservation slots for the chosen fulfillment date. */
async function loadTimeSlots(date) {
  const slotSelect = $id('time-slot');
  if (!slotSelect) return;
  if (!date) {
    slotSelect.innerHTML = '<option value="">Select a date first</option>';
    return;
  }
  slotSelect.innerHTML = '<option value="">Loading slots…</option>';
  try {
    const data = await api('/slots?date=' + encodeURIComponent(date));
    const slots = Array.isArray(data.slots) ? data.slots : [];
    if (!data.open || slots.length === 0) {
      slotSelect.innerHTML = '<option value="">Closed on this date — pick another</option>';
      return;
    }
    slotSelect.innerHTML = slots.map((s) =>
      `<option value="${esc(s.label)}"${s.full ? ' disabled' : ''}>${esc(s.label)}${s.full ? ' (Full)' : ''}</option>`
    ).join('');
  } catch (e) {
    console.warn('[webview] /slots failed:', e && e.message);
    slotSelect.innerHTML = '<option value="">Could not load time slots</option>';
    showToast('Could not load time slots — check your connection');
  }
}

async function placeOrder() {
  const orderType = $id('order-type').value;
  const name = $id('co-name').value.trim();
  const address = $id('address').value.trim();
  const phone = $id('phone').value.trim();
  const fulfillDate = $id('fulfill-date').value;
  const timeSlot = $id('time-slot').value;
  const notes = $id('notes') ? $id('notes').value.trim() : '';
  const paymentInput = document.querySelector('input[name="payment"]:checked');
  const paymentMethod = paymentInput ? paymentInput.value : null;

  if (!name) return showToast('Please enter your name');
  if (!phone) return showToast('Please enter contact number');
  if (orderType === 'delivery' && !address) return showToast('Please enter delivery address');
  if (!fulfillDate) return showToast('Please select fulfillment date');
  if (!timeSlot) return showToast('Please select a time slot');
  if (!paymentMethod) return showToast('Please select payment method');

  const btn = $id('place-order-btn');
  if (btn) { btn.disabled = true; btn.classList.add('btn-loading'); btn.textContent = 'Placing order…'; }
  showLoading('Placing your order…');

  // Client-side cart contents — the server re-prices every line from the DB,
  // so these only carry *what* was ordered, never the prices.
  const payloadItems = cart.items.map((it) => {
    const out = { quantity: Math.max(1, Number(it.quantity) || 1) };
    if (it.product_id) out.product_id = Number(it.product_id);
    if (it.package_id) out.package_id = Number(it.package_id);
    if (it.food_pack_id) out.food_pack_id = Number(it.food_pack_id);
    if (it.variant_size) out.variant_size = it.variant_size;
    if (it.package_id && Array.isArray(it.slot_choices)) {
      out.slot_choices = it.slot_choices.map((c) => ({ slot_number: Number(c.slot_number), product_id: Number(c.product_id) }));
    }
    return out;
  });

  // Delivery-fee groundwork: attach the confirmed location's coordinates so
  // the server can compute a distance-based fee (fee engine comes later —
  // the server currently ignores these fields, which is harmless).
  const savedLoc = getSavedLocation();
  const orderCoords = (savedLoc && savedLoc.lat != null && savedLoc.lng != null)
    ? { lat: savedLoc.lat, lng: savedLoc.lng }
    : {};

  let result;
  try {
    result = await api('/checkout', {
      method: 'POST',
      body: JSON.stringify({
        session: sessionId,
        order_type: orderType,
        name,
        address,
        phone,
        fulfillment_date: fulfillDate,
        time_slot: timeSlot,
        payment_method: paymentMethod,
        notes,
        items: payloadItems,
        ...orderCoords,
      }),
    });
  } catch (e) {
    hideLoading();
    // If timeout, check if order was actually created
    if (e && e.message === 'Request timed out') {
      if (btn) { btn.textContent = 'Checking order status…'; }
      try {
        const orders = await api('/orders?limit=1');
        if (orders && orders.length > 0) {
          const latestOrder = orders[0];
          // Check if order was created in the last 60 seconds
          const orderTime = new Date(latestOrder.created_at).getTime();
          const now = Date.now();
          if (now - orderTime < 60000) {
            // Order was created successfully
            saveCustomerData(name, phone, address);
            clearLocalCart();
            const successLine = $id('success-order-number');
            if (successLine) {
              successLine.textContent = 'Order #' + latestOrder.order_number +
                (latestOrder.total !== undefined && latestOrder.total !== null ? ' · ' + formatMoney(latestOrder.total) : '');
            }
            showView('view-success');
            if (isInsideMessenger) setTimeout(() => closeWebview(), 4000);
            return;
          }
        }
      } catch {
        // Fall through to error message
      }
    }
    if (btn) { btn.disabled = false; btn.classList.remove('btn-loading'); btn.textContent = 'Place Order'; }
    showToast((e && e.message) || 'Failed to place order');
    return;
  }
  hideLoading();

  if (result && result.ok) {
    // Save customer data for next order (remembered checkout)
    saveCustomerData(name, phone, address);
    clearLocalCart();
    const successLine = $id('success-order-number');
    if (successLine) {
      successLine.textContent = 'Order #' + result.order_number +
        (result.total !== undefined && result.total !== null ? ' · ' + formatMoney(result.total) : '');
    }
    showView('view-success');
    if (isInsideMessenger) setTimeout(() => closeWebview(), 4000);
  } else {
    if (btn) { btn.disabled = false; btn.classList.remove('btn-loading'); btn.textContent = 'Place Order'; }
    showToast((result && result.error) || 'Failed to place order');
  }
}

// ---------- Orders ----------
const STATUS_LABELS = {
  PENDING: 'Pending', CONFIRMED: 'Confirmed', PREPARING: 'Preparing',
  READY: 'Ready', COMPLETED: 'Completed', CANCELLED: 'Cancelled',
};
function statusLabel(s) { return STATUS_LABELS[s] || s || '—'; }

async function showOrders() {
  const container = $id('orders-list');
  if (!container) return;
  showLoading('Loading your orders…');
  try {
    await loadOrders();
  } catch (e) {
    showToast('Could not load orders — check your connection');
  } finally {
    hideLoading();
  }

  if (orders.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="icon">📋</div><p>No orders yet. Orders you place will appear here.</p></div>';
  } else {
    container.innerHTML = orders.map((o) => {
      const st = o.current_status || o.status;
      return `
      <div class="order-card" onclick="showOrderDetail(${Number(o.id)})">
        <div class="order-header">
          <span class="order-number">${esc(o.order_number || '#' + o.id)}</span>
          <span class="order-status status-${esc(st)}">${esc(statusLabel(st))}</span>
        </div>
        <div class="order-meta">
          ${o.order_type === 'pickup' ? 'Pickup' : 'Delivery'}${o.payment_method ? ' · ' + esc(o.payment_method) : ''}
          ${o.fulfillment_date ? `<br>${esc(o.fulfillment_date)}${o.time_slot ? ' · ' + esc(o.time_slot) : ''}` : ''}
        </div>
        <div class="order-total">${formatMoney(o.total)}</div>
      </div>`;
    }).join('');
  }
  showView('view-orders');
}

async function showOrderDetail(orderId) {
  showLoading('Loading order…');
  let order;
  try {
    order = await api('/orders/' + Number(orderId));
  } catch (e) {
    hideLoading();
    showToast((e && e.message) || 'Could not load order');
    return;
  }
  hideLoading();
  if (!order) { showToast('Order not found'); return; }

  const container = $id('order-detail');
  const items = Array.isArray(order.items) ? order.items : [];
  const itemsHtml = items.length > 0 ? items.map((it) => {
    const composition = (it.package_items || [])
      .map((pi) => esc(pi.product_name || 'Item #' + pi.product_id))
      .join(', ');
    return `
      <div class="cart-item">
        <div class="item-info">
          <div class="item-name">${esc(it.name || 'Item')}</div>
          ${composition ? `<div class="item-meta">${composition}</div>` : ''}
          ${it.variant_size ? `<div class="item-meta">Size: ${esc(it.variant_size)}</div>` : ''}
          <div class="item-price">${formatMoney(it.unit_price)} × ${it.quantity} = <strong>${formatMoney(it.line_total)}</strong></div>
        </div>
      </div>`;
  }).join('') : '<div class="empty-state"><div class="icon">🧾</div><p>No item details for this order.</p></div>';

  const st = order.current_status || order.status;
  const canCancel = st === 'PENDING';

  container.innerHTML = `
    <div class="order-card">
      <div class="order-header">
        <span class="order-number">${esc(order.order_number || '#' + order.id)}</span>
        <span class="order-status status-${esc(st)}">${esc(statusLabel(st))}</span>
      </div>
      <div class="order-meta">
        ${order.order_type === 'pickup' ? 'Pickup' : 'Delivery'}
        ${order.fulfillment_date ? ` · ${esc(order.fulfillment_date)}${order.time_slot ? ' ' + esc(order.time_slot) : ''}` : ''}
        ${order.payment_method ? `<br>Payment: ${esc(order.payment_method)}` : ''}
        ${order.address ? `<br>Address: ${esc(order.address)}` : ''}
        ${order.notes ? `<br>Notes: ${esc(order.notes)}` : ''}
        ${order.created_at ? `<br>Placed: ${esc(new Date(order.created_at).toLocaleString())}` : ''}
      </div>
    </div>
    <div class="section-spaced">${itemsHtml}</div>
    <div class="total-row line-item"><span>Subtotal</span><span>${formatMoney(order.subtotal)}</span></div>
    ${Number(order.delivery_fee) > 0 ? `<div class="total-row line-item"><span>Delivery</span><span>${formatMoney(order.delivery_fee)}</span></div>` : ''}
    ${Number(order.discount) > 0 ? `<div class="total-row discount"><span>Savings</span><span>−${formatMoney(order.discount)}</span></div>` : ''}
    <div class="total-row grand"><span>Total</span><span class="value">${formatMoney(order.total)}</span></div>
    ${canCancel ? `<button class="btn btn-cancel" id="cancel-order-btn" onclick="cancelMyOrder(${Number(order.id)})">Cancel Order</button>` : ''}
  `;
  showView('view-order-detail');
}

async function cancelMyOrder(orderId) {
  if (!window.confirm('Cancel this order?')) return;
  const btn = $id('cancel-order-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }
  try {
    await api('/orders/' + Number(orderId) + '/cancel', { method: 'POST' });
  } catch (e) {
    showToast((e && e.message) || 'Could not cancel order');
    if (btn) { btn.disabled = false; btn.textContent = 'Cancel Order'; }
    return;
  }
  showToast('Order cancelled');
  showOrders();
}

// ---------- Messenger Extensions ----------
/** True when the page runs inside Messenger's in-app browser (UA fallback). */
function detectMessengerUserAgent() {
  const ua = navigator.userAgent || '';
  return /\b(FBAV|FB_IAB|FBAN|MessengerForiOS|Orca-Android|Messenger)\b/i.test(ua) || /\[FB_IAB\]/.test(ua);
}

/** Wait up to ~2s for the MessengerExtensions SDK, then resolve detection. */
async function detectMessenger() {
  if (window.__messengerExtensionsReady) return true;
  if (window.MessengerExtensions && typeof window.MessengerExtensions.isInExtension === 'function') {
    try { if (window.MessengerExtensions.isInExtension()) return true; } catch { /* ignore */ }
  }
  // Check if opened via Messenger button with psid parameter
  if (new URLSearchParams(window.location.search).get('psid')) return true;

  for (let i = 0; i < 10; i++) {
    if (window.__messengerExtensionsReady) return true;
    if (window.MessengerExtensions && typeof window.MessengerExtensions.isInExtension === 'function') {
      try { if (window.MessengerExtensions.isInExtension()) return true; } catch { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return detectMessengerUserAgent();
}

/** Close the in-Messenger webview and return the user to the chat thread. */
function closeWebview() {
  const ext = window.MessengerExtensions;
  if (ext && typeof ext.requestCloseBrowser === 'function') {
    try {
      ext.requestCloseBrowser(
        () => { console.log('[webview] in-app webview closed successfully'); },
        (err) => {
          console.warn('[webview] requestCloseBrowser returned error:', err);
          window.close();
          setTimeout(() => { if (!window.closed) showCategories(); }, 300);
        },
      );
      return;
    } catch (e) {
      console.error('[webview] MessengerExtensions error:', e);
    }
  }
  // Fallback when opened in a normal browser: try window.close(), else go home.
  window.close();
  setTimeout(() => { if (!window.closed) showCategories(); }, 300);
}

// ---------- Location gate (first-run modal) ----------
// Customers must set a delivery location before the home menu unlocks —
// FoodPanda-style. A real location is REQUIRED: either the device GPS or a
// pin dropped on the embedded map (works even where the browser blocks
// geolocation, e.g. Messenger's in-app browser or plain-HTTP origins).
// The saved location (address + lat/lng) is kept per session in localStorage
// and rides along with checkout for the future delivery-fee calculation
// (the fee engine itself is intentionally not implemented yet).
const LOCATION_KEY = () => 'webview_location_' + sessionId;

// Store's home area — centers the map and acts as the delivery-fee origin later.
const STORE_LOCATION = { lat: 13.6218, lng: 123.1948, label: 'Naga City' };

// --- Google Maps + Places + Geocoder ---
// The API key arrives from the server (env GOOGLE_MAPS_API_KEY) via /config.
// We load the JS API dynamically so the page works even when no key is set
// (location gate falls back to address-only mode).
let googleMap = null;
let googleMarker = null;
let googleGeocoder = null;
let googlePlacesService = null;
let googleAutocomplete = null;
let googleMapInitFailed = false;
let googleMapReady = false;

/** Dynamically load the Google Maps JavaScript API (Places library). */
function loadGoogleMaps() {
  return new Promise((resolve) => {
    if (window.google && window.google.maps) {
      resolve(true);
      return;
    }
    if (!serverMapsApiKey) {
      console.warn('[webview] no Google Maps API key — falling back to address-only mode');
      googleMapInitFailed = true;
      resolve(false);
      return;
    }
    window.__googleMapsInit = () => { googleMapReady = true; resolve(true); };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${serverMapsApiKey}&libraries=places&callback=__googleMapsInit`;
    s.onerror = () => {
      console.warn('[webview] Google Maps failed to load — falling back to address-only mode');
      googleMapInitFailed = true;
      resolve(false);
    };
    document.head.appendChild(s);
    // 8s timeout for the script to load.
    setTimeout(() => {
      if (!googleMapReady && !googleMapInitFailed) {
        googleMapInitFailed = true;
        resolve(false);
      }
    }, 8000);
  });
}

/** Saved delivery location for this session (or null when not set yet). */
function getSavedLocation() {
  try {
    const loc = JSON.parse(storageGet(LOCATION_KEY()) || 'null');
    return loc && loc.address ? loc : null;
  } catch { return null; }
}

function saveLocation(loc) {
  try { storageSet(LOCATION_KEY(), JSON.stringify(loc)); } catch { /* non-fatal */ }
}

/** True when Google Maps loaded and the map was initialized successfully.
 * When false, the customer can still confirm with address-only — delivery fee
 * will fall back to a default/zone rate instead of a distance-based one. */
function mapAvailable() {
  return window.google && window.google.maps && !!googleMap && !googleMapInitFailed;
}

/** Show the mandatory location modal. Always shown on every webview open so
 * customers can review or update their delivery location. When a location was
 * already saved this session, pre-fill the address and re-drop the pin on the
 * map so returning customers only need to re-confirm (not re-type). */
function showLocationGate() {
  const gate = $id('location-gate');
  if (!gate) return;
  const mainContent = $id('main-content');
  if (mainContent) mainContent.classList.add('hidden');
  // Prefill from the address remembered at checkout so repeat customers
  // only need to drop/keep the pin and confirm.
  const remembered = loadCustomerData();
  if (remembered && remembered.address) $id('loc-address').value = remembered.address;
  // Pre-fill from a previously saved gate location too, and restore the pin
  // on the map so the customer sees their saved spot visually.
  const saved = getSavedLocation();
  if (saved && saved.address && !$id('loc-address').value) {
    $id('loc-address').value = saved.address;
  }
  gate.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  const wrap = document.querySelector('.loc-map-wrap');
  if (wrap) wrap.style.display = '';

  // Load Google Maps dynamically (no-op if already loaded or no key).
  // Once loaded, initialize the map. If loading fails, fall back to address-only.
  loadGoogleMaps().then((ok) => {
    if (ok && mapAvailable()) {
      initGoogleMap();
      // Restore the saved pin so returning customers see their spot.
      if (saved && saved.lat != null && saved.lng != null && googleMap) {
        setMapPin({ lat: saved.lat, lng: saved.lng }, false);
        googleMap.setCenter({ lat: saved.lat, lng: saved.lng });
        googleMap.setZoom(15);
      }
    } else {
      if (wrap) wrap.style.display = 'none';
      showLocError('Map unavailable — please enter your address manually below.');
    }
  });

  // Re-validate the confirm button as the address is typed.
  const addrEl = $id('loc-address');
  if (addrEl && !addrEl.dataset.locBound) {
    addrEl.dataset.locBound = '1';
    addrEl.addEventListener('input', updateLocConfirmState);
  }
  // Wire up Google Places autocomplete on the search box.
  const searchEl = $id('loc-search');
  if (searchEl && !searchEl.dataset.locBound) {
    searchEl.dataset.locBound = '1';
    initPlacesAutocomplete();
  }
  updateLocConfirmState();
}

/** Create the Google Maps map once, after the modal is visible. */
function initGoogleMap() {
  if (googleMap) {
    // Re-opened — trigger a resize to recalculate dimensions.
    setTimeout(() => {
      if (window.google && googleMap) {
        google.maps.event.trigger(googleMap, 'resize');
      }
    }, 150);
    return;
  }
  try {
    const mapEl = $id('loc-map');
    if (!mapEl || !window.google) throw new Error('Google Maps not available');

    googleMap = new google.maps.Map(mapEl, {
      center: { lat: STORE_LOCATION.lat, lng: STORE_LOCATION.lng },
      zoom: 14,
      disableDefaultUI: true,
      zoomControl: true,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      gestureHandling: 'cooperative',
    });

    googleGeocoder = new google.maps.Geocoder();

    // Tap anywhere to drop/move the pin.
    googleMap.addListener('click', (e) => {
      setMapPin({ lat: e.latLng.lat(), lng: e.latLng.lng() }, false);
    });
  } catch (e) {
    console.warn('[webview] Google Maps init failed, falling back to address-only:', e && e.message);
    googleMap = null;
    googleMarker = null;
    googleMapInitFailed = true;
    const wrap = document.querySelector('.loc-map-wrap');
    if (wrap) wrap.style.display = 'none';
    showLocError('Map unavailable — please enter your address manually below.');
  }
}

/** Hide the location modal and restore page scrolling. */
function hideLocationGate() {
  const gate = $id('location-gate');
  if (gate) gate.classList.add('hidden');
  const mainContent = $id('main-content');
  if (mainContent) mainContent.classList.remove('hidden');
  document.body.style.overflow = '';
}

function showLocError(msg) {
  const el = $id('loc-gate-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideLocError() {
  const el = $id('loc-gate-error');
  if (el) el.classList.add('hidden');
}

// Coordinates of the chosen delivery point — set by the GPS button or by
// dropping the pin on the map. Saved with the confirmed address and sent
// with checkout for the future delivery-fee distance calculation.
let pendingCoords = null;
// Where the point came from: 'gps' or 'pin' (map tap/drag).
let pinSource = null;

/** Drop/move the pin and remember the chosen point. */
function setMapPin(latlng, fromGps) {
  pendingCoords = { lat: latlng.lat, lng: latlng.lng };
  pinSource = fromGps ? 'gps' : 'pin';
  if (mapAvailable()) {
    if (!googleMarker) {
      googleMarker = new google.maps.Marker({
        position: { lat: latlng.lat, lng: latlng.lng },
        map: googleMap,
        draggable: true,
        title: 'Delivery location',
      });
      // Dragging fine-tunes the point (same handling as a fresh tap).
      googleMarker.addListener('dragend', () => {
        const pos = googleMarker.getPosition();
        setMapPin({ lat: pos.lat(), lng: pos.lng() }, false);
      });
    } else {
      googleMarker.setPosition({ lat: latlng.lat, lng: latlng.lng });
    }
  }
  hideLocError();
  updateLocConfirmState();
  if (!fromGps) {
    // Name the picked point so the address box pre-fills — only when empty,
    // never stomping on what the customer already typed.
    reverseGeocode(latlng.lat, latlng.lng)
      .then((addr) => {
        const el = $id('loc-address');
        if (el && !el.value.trim()) el.value = addr;
        updateLocConfirmState();
      })
      .catch(() => { /* offline / rate-limited — address stays hand-typed */ });
  }
}

/** GPS button — locate the device, pin it on the map and reverse-geocode it. */
function useCurrentLocation() {
  hideLocError();
  const btn = $id('loc-gps-btn');
  const label = $id('loc-gps-label');
  if (!btn || !label) return;

  // Geolocation only exists on secure origins (HTTPS / localhost) and is
  // frequently blocked inside Messenger's in-app browser — the map below is
  // the guaranteed fallback there.
  if (!navigator.geolocation || !window.isSecureContext) {
    showLocError('Location services aren\u2019t available here — tap your spot on the map below instead.');
    return;
  }

  btn.disabled = true;
  label.textContent = 'Getting your location…';
  const resetBtn = () => { btn.disabled = false; label.textContent = 'Use my current location'; };

  navigator.geolocation.getCurrentPosition(async (pos) => {
    const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    if (mapAvailable()) {
      setMapPin(coords, true);
      googleMap.setCenter({ lat: coords.lat, lng: coords.lng });
      googleMap.setZoom(16);
    } else {
      pendingCoords = coords;
      updateLocConfirmState();
    }
    try {
      const address = await reverseGeocode(coords.lat, coords.lng);
      $id('loc-address').value = address;
      updateLocConfirmState();
      showToast('📍 Location found — check it and confirm');
    } catch (e) {
      console.warn('[webview] reverse geocode failed:', e && e.message);
      // GPS worked but naming the address didn't — keep the pin/coords and
      // let the customer complete the address manually.
      showLocError('We got your position but couldn\u2019t name the address — please complete it below.');
      $id('loc-address').focus();
    }
    resetBtn();
  }, (err) => {
    resetBtn();
    console.warn('[webview] geolocation failed:', err && err.code, err && err.message);
    if (err && err.code === 1) showLocError('Location permission was denied — tap your spot on the map below instead.');
    else if (err && err.code === 3) showLocError('Getting your location timed out — try again or tap the map below.');
    else showLocError('Could not get your location — tap your spot on the map below instead.');
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
}

/** Reverse-geocode coordinates into a readable address (Google Geocoder). */
async function reverseGeocode(lat, lng) {
  if (!googleGeocoder) throw new Error('Geocoder not available');
  return new Promise((resolve, reject) => {
    googleGeocoder.geocode({ location: { lat, lng } }, (results, status) => {
      if (status === 'OK' && results && results[0]) {
        resolve(results[0].formatted_address);
      } else {
        reject(new Error('Geocode failed: ' + status));
      }
    });
  });
}

/** Forward-geocode an address string into coordinates (Google Geocoder). */
async function geocodeAddress(query) {
  if (!googleGeocoder) throw new Error('Geocoder not available');
  return new Promise((resolve, reject) => {
    googleGeocoder.geocode({ address: query }, (results, status) => {
      if (status === 'OK' && results && results[0]) {
        const loc = results[0].geometry.location;
        resolve([{
          label: results[0].formatted_address,
          lat: loc.lat(),
          lng: loc.lng(),
        }]);
      } else if (status === 'ZERO_RESULTS') {
        resolve([]);
      } else {
        reject(new Error('Geocode failed: ' + status));
      }
    });
  });
}

/** Drop the pin from a search result, fill the address, and pan the map. */
function selectSearchResult(result) {
  if (!result || !result.lat || !result.lng) return;
  const coords = { lat: result.lat, lng: result.lng };
  if (mapAvailable()) {
    setMapPin(coords, false);
    googleMap.setCenter({ lat: coords.lat, lng: coords.lng });
    googleMap.setZoom(16);
  } else {
    pendingCoords = coords;
    pinSource = 'pin';
    updateLocConfirmState();
  }
  const addrEl = $id('loc-address');
  if (addrEl) {
    addrEl.value = result.label;
    updateLocConfirmState();
  }
  hideLocError();
}

// (Google Places Autocomplete manages its own suggestion dropdown)

/** Wire up Google Places Autocomplete on the search input. The Places widget
 *  attaches its own suggestion dropdown — we just listen for place changes. */
function initPlacesAutocomplete() {
  const input = $id('loc-search');
  if (!input || !window.google || !google.maps || !google.maps.places) return;
  try {
    googleAutocomplete = new google.maps.places.Autocomplete(input, {
      types: ['geocode', 'establishment'],
      fields: ['formatted_address', 'geometry', 'name'],
    });
    // Bias suggestions toward the store's city so local results rank higher.
    const bounds = new google.maps.LatLngBounds(
      { lat: STORE_LOCATION.lat - 0.15, lng: STORE_LOCATION.lng - 0.15 },
      { lat: STORE_LOCATION.lat + 0.15, lng: STORE_LOCATION.lng + 0.15 },
    );
    googleAutocomplete.setBoundsBias(bounds);
    googleAutocomplete.addListener('place_changed', () => {
      const place = googleAutocomplete.getPlace();
      if (!place || !place.geometry || !place.geometry.location) return;
      const coords = { lat: place.geometry.location.lat(), lng: place.geometry.location.lng() };
      const label = place.formatted_address || place.name || '';
      selectSearchResult({ label, ...coords });
    });
  } catch (e) {
    console.warn('[webview] Places Autocomplete init failed:', e && e.message);
  }
}

/** Live guidance under the map: exactly what's still missing before confirming. */
function updateLocConfirmState() {
  const status = $id('loc-status');
  if (!status) return;
  if (!mapAvailable()) { status.textContent = ''; return; }
  const address = (($id('loc-address') && $id('loc-address').value) || '').trim();
  const hasAddress = address.length >= 5;
  status.classList.toggle('loc-status-ok', !!pendingCoords && hasAddress);
  if (!pendingCoords) {
    status.textContent = '📍 Tap the map to drop your pin — or use "Use my current location"';
  } else if (!hasAddress) {
    status.textContent = '✓ Pin saved — now complete your address below';
  } else {
    status.textContent = '✓ Location set — ready to confirm!';
  }
}

/** Confirm button — validate and persist the delivery location, then unlock home. */
function confirmLocation() {
  hideLocError();
  const address = (($id('loc-address') && $id('loc-address').value) || '').trim();
  if (address.length < 5) {
    showLocError('Please enter your complete address (house #, street, barangay, city).');
    return;
  }
  if (mapAvailable() && !pendingCoords) {
    showLocError('Please set your location first — tap the map or use "Use my current location".');
    return;
  }
  const landmark = (($id('loc-landmark') && $id('loc-landmark').value) || '').trim();
  saveLocation({
    address,
    landmark: landmark || null,
    lat: pendingCoords ? pendingCoords.lat : null,
    lng: pendingCoords ? pendingCoords.lng : null,
    source: pendingCoords ? pinSource : 'manual',
    savedAt: new Date().toISOString(),
  });
  // When source is 'manual' (customer typed an address without GPS / map pin),
  // lat/lng are null. The future delivery-fee engine should handle this by:
  //   1. Using a default/flat delivery fee, or
  //   2. Parsing the address (barangay, city) for zone-based pricing, or
  //   3. Geocoding the address server-side (Google Maps / OpenStreetMap) to
  //      recover coordinates and compute a distance-based fee.
  // For now the location is stored as-is and the checkout delivery line stays
  // "To be decided" until the fee logic is wired up.
  pendingCoords = null;
  pinSource = null;
  hideLocationGate();
  showToast('📍 Location saved!');
}

// ---------- Init ----------
/**
 * Ask MessengerExtensions for the current user's PSID (waits up to ~2.5s for the SDK).
 * Used when the webview is opened without the ?psid= parameter so the cart and
 * orders still bind to the Messenger customer account.
 */
function resolveMessengerUser() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let tries = 0;
    (function attempt() {
      const ext = window.MessengerExtensions;
      if (ext && typeof ext.getUserID === 'function') {
        try {
          ext.getUserID(
            (uids) => finish(uids && uids.psid ? String(uids.psid) : null),
            () => finish(null),
          );
          return;
        } catch { finish(null); return; }
      }
      if (++tries < 15) setTimeout(attempt, 200);
      else finish(null);
    })();
    setTimeout(() => finish(null), 3000);
  });
}

let initStarted = false;
async function init() {
  if (initStarted) return;
  initStarted = true;
  showLoading('Loading menu...');

  // Detect Messenger in parallel — never let the SDK poll block catalog loading.
  const messengerDetection = detectMessenger();

  // Check if webview is enabled (assume enabled when the check itself fails).
  let enabled = true;
  try {
    const enabledData = await api('/enabled');
    enabled = enabledData && enabledData.enabled !== false;
  } catch (e) {
    console.warn('[webview] /enabled check failed — assuming enabled:', e && e.message);
  }

  const mainContent = $id('main-content');
  const nav = $id('bottom-nav');

  if (!enabled) {
    hideLoading();
    const disabled = $id('disabled-msg');
    if (disabled) disabled.classList.remove('hidden');
    if (mainContent) mainContent.classList.add('hidden');
    if (nav) nav.style.display = 'none';
    return;
  }

  // When opened without ?psid (shared URL), resolve the PSID from the Messenger
  // SDK BEFORE loading the cart so the local cart + orders bind to the customer.
  if (!psidFromMessenger) {
    const msgrPsid = await resolveMessengerUser();
    if (msgrPsid && msgrPsid !== sessionId) {
      console.log('[webview] PSID resolved from MessengerExtensions');
      sessionId = msgrPsid;
      storageSet('webview_session', sessionId);
    }
  }

  // Load everything; settle all results so one failed loader can't blank the menu.
  const results = await Promise.allSettled([
    loadCategories(),
    loadProducts(),
    loadPackages(),
    loadFoodPacks(),
    loadCart(),
    loadConfig(),
    loadOrders(),
  ]);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    console.warn('[webview] ' + failed.length + ' loader(s) failed:', failed.map((f) => f.reason && f.reason.message));
  }

  // loadCart() runs in parallel with the catalog loaders, so its initial
  // recalcCartTotals() sees an empty catalog and stores 0 totals for every
  // line. Now that products/packages/food packs are loaded, re-price the
  // restored cart and persist the corrected totals.
  recalcCartTotals();
  storageSet(LOCAL_CART_KEY(), JSON.stringify(cart));
  updateCartBadge();
  console.log('[webview] init complete →', {
    categories: categories.length,
    products: products.length,
    packages: packages.length,
    foodPacks: foodPacks.length,
    cartItems: cart.items.length,
    orders: orders.length,
    sessionId,
    isInsideMessenger: await messengerDetection,
  });

  isInsideMessenger = await messengerDetection;
  hideLoading();

  // No catalog data at all → show an actionable error instead of a blank menu.
  if (categories.length === 0) {
    if (mainContent) mainContent.classList.add('hidden');
    if (nav) nav.style.display = 'none';
    const errBox = $id('load-error');
    if (errBox) errBox.classList.remove('hidden');
    return;
  }

  if (mainContent) mainContent.classList.remove('hidden');
  renderCategories();
  showCategories();

  // Location gate: customers confirm their delivery location before using the app.
  // This runs on EVERY webview open (not just first run) so the customer always
  // has a chance to review or update their location. A previously saved location
  // is pre-filled so returning customers only need to re-confirm, not re-type.
  showLocationGate();
}

function retryLoad() {
  initStarted = false;
  const errBox = $id('load-error');
  if (errBox) errBox.classList.add('hidden');
  const disabled = $id('disabled-msg');
  if (disabled) disabled.classList.add('hidden');
  const mainContent = $id('main-content');
  if (mainContent) mainContent.classList.add('hidden');
  const nav = $id('bottom-nav');
  if (nav) nav.style.display = '';
  showLoading();
  init();
}

init();
