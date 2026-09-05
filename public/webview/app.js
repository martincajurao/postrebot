// ===== Postre Food Products — Webview (order online) =====
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
let isInsideMessenger = false;
let currentView = 'categories';
let currentCategoryId = null;
let productDetail = { productId: null, size: null, qty: 1 };
let packageDetail = { pkgId: null, choices: {}, size: 'M', qty: 1 };

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

/** Image with a graceful fallback for missing/broken photos. */
function imageHtml(url, alt, cls) {
  url = absUrl(url);
  const attrs = cls ? ` class="${cls}"` : '';
  const img = url
    ? `<img${attrs} src="${esc(url)}" alt="${esc(alt || '')}" loading="lazy" onerror="this.style.display='none'">`
    : '';
  return `<div class="img-wrap ${cls}"><span class="img-ghost">🍽️</span>${img}</div>`.replace('  ', ' ');
}

function showToast(msg) {
  const t = $id('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add('hidden'), 2500);
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
  'food-packs': 2,
  'cart': 3, 'checkout': 3,
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
  else showCategories();
}

function updateCartBadge() {
  const badge = $id('cart-badge');
  if (!badge) return;
  const count = cart.items.reduce((s, i) => s + i.quantity, 0);
  badge.textContent = count;
  badge.classList.toggle('hidden', count === 0);
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
  const timer = controller ? setTimeout(() => controller.abort(), 15000) : null;
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
    ? choices.map((c) => Number(c.slot_number) + ':' + Number(c.product_id)).sort().join('|')
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

/** Recompute display totals from the loaded catalog. */
function recalcCartTotals() {
  let subtotal = 0;
  let discount = 0;
  const breakdown = [];
  for (const it of cart.items) {
    const unit = cartItemUnitPrice(it);
    if (unit === null || unit === undefined) continue;
    const line = unit * it.quantity;
    subtotal += line;
    breakdown.push({ label: (it.name || 'Item') + ' x' + it.quantity, amount: line });
    if (it.package_id) {
      const pkg = packages.find((p) => Number(p.id) === Number(it.package_id));
      if (pkg && Number(pkg.discount) > 0) discount += Math.min(Number(pkg.discount), Math.max(0, unit)) * it.quantity;
    }
  }
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
  const container = $id('categories-list');
  if (!container) return;
  if (categories.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="icon">🍽️</div><p>No categories available right now.</p></div>';
  } else {
    container.innerHTML = categories.map((c) => {
      const count = products.filter((p) => Number(p.category_id) === Number(c.id)).length;
      return `<div class="category-card" onclick="showProducts(${c.id})">
        <div class="icon">${categoryIcon(c.name)}</div>
        <div class="name">${esc(c.name)}</div>
        <div class="count">${count} ${count === 1 ? 'item' : 'items'}</div>
      </div>`;
    }).join('');
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
  const card = event && event.target ? event.target.closest('.product-card, .pkg-card') : null;
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

  container.innerHTML = list.map((p) => {
    const unavailable = Number(p.unavailable) === 1;
    const vs = productVariants(p);
    const selSize = cardSizes['product-' + p.id] || (vs[0] ? vs[0].size : null);
    const sizePills = vs.length > 1
      ? `<div class="card-sizes">${vs.map((v) =>
          `<button class="size-pill${v.size === selSize ? ' selected' : ''}" onclick="selectCardSize(event, 'product', ${p.id}, '${esc(v.size)}')">${esc(v.size)}</button>`
        ).join('')}</div>`
      : '';
    return `<div class="product-card${unavailable ? ' unavailable' : ''}" ${unavailable ? '' : `onclick="showProductDetail(${p.id})"`}>
      ${imageHtml(p.photo_url, p.name)}
      <div class="info">
        <div class="name">${esc(p.name)}</div>
        ${p.description ? `<div class="desc">${esc(p.description)}</div>` : ''}
        <div class="price card-price">${productCardPrice(p, selSize)}</div>
        ${sizePills}
        ${unavailable ? '' : `<div class="card-actions"><button class="card-add-btn" onclick="addToCartProductQuick(${p.id}, event)">+ Add to Cart</button></div>`}
        ${unavailable ? '<span class="badge-flag">Unavailable</span>' : ''}
      </div>
    </div>`;
  }).join('');
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
  container.innerHTML = packages.map((pkg) => {
    const saved = Number(pkg.discount) > 0;
    const slots = pkg.slots || [];
    const selSize = cardSizes['package-' + pkg.id] || 'M';
    const defaults = packageDefaultChoices(pkg);
    const canQuickAdd = !pkg.is_custom && (Number(pkg.selections) || slots.length || 0) <= defaults.length && defaults.length > 0;

    // Preview of the dishes included (default picks) — up to 3, then "+N more".
    const names = pkg.is_custom
      ? []
      : slots.map((slot) => {
          const opts = packageSlotOptions(pkg, slot);
          const def = opts.find((o) => Number(o.is_default) === 1) || opts[0];
          return def ? def.name : null;
        }).filter(Boolean);
    const dishPreview = names.length > 0
      ? `<div class="pkg-dishes">${esc(names.slice(0, 3).join(', '))}${names.length > 3 ? ` +${names.length - 3} more` : ''}</div>`
      : '';

    const meta = pkg.is_custom
      ? `Pick any ${esc(String(pkg.selections || slots.length || '?'))} dishes`
      : `${slots.length || esc(String(pkg.selections || '?'))} dishes · Ready to order`;

    return `<div class="pkg-card" onclick="showPackageDetail(${pkg.id})">
      ${imageHtml(pkg.photo_url, pkg.name, 'pkg-img')}
      <div class="pkg-body">
        <div class="pkg-name">${esc(pkg.name)}</div>
        ${pkg.description ? `<div class="pkg-meta">${esc(pkg.description)}</div>` : ''}
        <div class="pkg-meta">${meta}</div>
        ${dishPreview}
        <div class="pkg-size-row">
          <button class="size-pill${selSize === 'M' ? ' selected' : ''}" onclick="selectCardSize(event, 'package', ${pkg.id}, 'M')">M</button>
          <button class="size-pill${selSize === 'L' ? ' selected' : ''}" onclick="selectCardSize(event, 'package', ${pkg.id}, 'L')">L</button>
          <span class="pkg-price-line">
            ${saved ? `<span class="was">${formatMoney(pkg.base_price)}</span>` : ''}
            <span class="price card-price">${packageCardPrice(pkg, selSize)}</span>
            ${saved ? `<span class="save">Save ${formatMoney(pkg.discount)}</span>` : ''}
          </span>
        </div>
        <div class="card-actions">
          <button class="card-add-btn" onclick="${canQuickAdd ? `addToCartPackageQuick(${pkg.id}, event)` : `showPackageDetail(${pkg.id})`}">
            ${canQuickAdd ? '+ Add to Cart' : 'Choose Dishes'}
          </button>
        </div>
      </div>
    </div>`;
  }).join('');
  showView('view-packages');
}

async function retryPackages() {
  showLoading('Loading packages…');
  await loadPackages();
  hideLoading();
  showPackages();
}

/**
 * Options available for a package slot.
 * - Fixed/preset packages: admin-defined option rows (already carry name/photo/upgrade).
 * - Custom ("Build your own") packages: every active dish, matching the bot.
 */
function packageSlotOptions(pkg, slot) {
  if (!pkg.is_custom) return slot.options || [];
  return products
    .filter((p) => Number(p.unavailable) !== 1)
    .map((p) => ({
      id: null,
      product_id: p.id,
      name: p.name,
      photo_url: p.photo_url,
      upgrade_price: 0,
      size_upgrade_price: 0,
      is_default: 0,
    }));
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
  packageDetail = { pkgId: Number(pkg.id), choices, size: cardSizes['package-' + Number(pkg.id)] || 'M', qty: 1 };
  renderPackageDetail();
}

function currentPackage() {
  return packages.find((x) => Number(x.id) === Number(packageDetail.pkgId)) || null;
}

/** Client-side mirror of server pricing: base + slot upgrades (± size) − package discount. */
function pricePackageChoices(pkg, choices, size) {
  const slots = (pkg.slots || []).slice().sort((a, b) => a.slot_number - b.slot_number);
  let total = Number(pkg.base_price) || 0;
  const lines = [{ label: esc(pkg.name) + ' base', amount: total }];
  for (const slot of slots) {
    const choice = choices[Number(slot.slot_number)];
    if (choice === undefined || choice === null) continue;
    const options = packageSlotOptions(pkg, slot);
    const opt = options.find((o) => Number(o.product_id) === Number(choice)) || null;
    let extra = opt ? Number(opt.upgrade_price) || 0 : 0;
    if (size === 'L') {
      let sizeExtra = opt ? Number(opt.size_upgrade_price) || 0 : 0;
      if (!sizeExtra) sizeExtra = variantPriceDiff(choice);
      extra += sizeExtra;
    }
    if (extra > 0) {
      lines.push({ label: (opt && opt.name) + ' upgrade', amount: extra });
      total += extra;
    }
  }
  const discount = Number(pkg.discount) || 0;
  if (discount > 0) {
    const applied = Math.min(discount, Math.max(0, total));
    lines.push({ label: 'Package discount', amount: -applied });
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

function renderPackageDetail() {
  const pkg = currentPackage();
  if (!pkg) return;
  const container = $id('package-detail');
  const slots = (pkg.slots || []).slice().sort((a, b) => a.slot_number - b.slot_number);
  const chosen = Object.keys(packageDetail.choices).length;
  const needed = Number(pkg.selections) || slots.length || 0;
  const complete = chosen >= needed;
  const pricing = pricePackageChoices(pkg, packageDetail.choices, packageDetail.size);

  let slotsHtml = '';
  if (slots.length > 0) {
    slotsHtml = slots.map((slot) => {
      const options = packageSlotOptions(pkg, slot);
      if (options.length === 0) return '';
      const cur = packageDetail.choices[Number(slot.slot_number)];
      return `<div class="package-slot">
        <h4>${esc(slot.name) || 'Slot ' + slot.slot_number}</h4>
        <div class="slot-options">
          ${options.map((opt) => {
            const selected = cur !== undefined && cur !== null && Number(cur) === Number(opt.product_id);
            const upgrade = Number(opt.upgrade_price) || 0;
            return `<span class="slot-option${selected ? ' selected' : ''}" onclick="selectPackageSlot(${slot.slot_number}, ${opt.product_id}, this)">
              ${esc(opt.name)}${upgrade > 0 ? ` <em>+${formatMoney(upgrade)}</em>` : ''}
            </span>`;
          }).join('')}
        </div>
      </div>`;
    }).join('');
  } else {
    slotsHtml = '<div class="empty-state"><div class="icon">🥡</div><p>This package has no dish slots defined.</p></div>';
  }

  container.innerHTML = `
    ${imageHtml(pkg.photo_url, pkg.name, 'detail-image')}
    <div class="detail-name">${esc(pkg.name)}</div>
    <div class="detail-desc">${esc(pkg.description || '')}</div>
    <div class="pkg-price-line compact">
      ${Number(pkg.discount) > 0 ? `<span class="was">${formatMoney(pkg.base_price)}</span>` : ''}
      <span class="price">${formatMoney(netPackagePrice(pkg))}</span>
      ${Number(pkg.discount) > 0 ? `<span class="save">Save ${formatMoney(pkg.discount)}</span>` : ''}
    </div>
    ${slotsHtml}
    ${pkg.is_custom ? `<div class="detail-desc"><strong>${chosen}/${needed}</strong> dishes chosen — pick one dish per slot.</div>` : ''}
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
    <div class="price-total">${formatMoney(pricing.total * packageDetail.qty)}</div>
    <button class="btn btn-primary btn-checkout" onclick="addToCartPackage()" ${complete ? '' : 'disabled'}>
      ${complete ? 'Add to Cart' : `Choose ${needed} dishes (${chosen}/${needed})`}
    </button>
  `;
  showView('view-package');
}

function selectPackageSlot(slotNumber, productId, el) {
  if (!el) return;
  el.parentElement.querySelectorAll('.slot-option').forEach((o) => o.classList.remove('selected'));
  el.classList.add('selected');
  packageDetail.choices[slotNumber] = productId;
  const pkg = currentPackage();
  if (!pkg) return;
  const needed = Number(pkg.selections) || (pkg.slots || []).length || 0;
  const chosen = Object.keys(packageDetail.choices).length;
  const pricing = pricePackageChoices(pkg, packageDetail.choices, packageDetail.size);
  const totalEl = $id('package-detail').querySelector('.price-total');
  if (totalEl) totalEl.textContent = formatMoney(pricing.total * packageDetail.qty);
  const btn = $id('package-detail').querySelector('.btn-checkout');
  if (btn) {
    btn.disabled = chosen < needed;
    btn.textContent = chosen >= needed ? 'Add to Cart' : `Choose ${needed} dishes (${chosen}/${needed})`;
  }
  const counter = $id('package-detail').querySelector('.detail-desc strong');
  if (counter && pkg.is_custom) counter.textContent = `${chosen}/${needed}`;
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
  const pricing = pricePackageChoices(pkg, packageDetail.choices, packageDetail.size);
  const totalEl = $id('package-detail').querySelector('.price-total');
  if (totalEl) totalEl.textContent = formatMoney(pricing.total * packageDetail.qty);
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
  container.innerHTML = foodPacks.map((fp) => `
    <div class="product-card" onclick="addToCartFoodPack(${fp.id})">
      ${imageHtml(fp.photo_url, fp.name)}
      <div class="info">
        <div class="name">${esc(fp.name)}</div>
        ${fp.description ? `<div class="desc">${esc(fp.description)}</div>` : ''}
        ${fp.serves ? `<div class="serves">Serves ${esc(fp.serves)}</div>` : ''}
        <div class="price">${formatMoney(fp.price)}</div>
      </div>
    </div>`).join('');
  showView('view-food-packs');
}

async function retryFoodPacks() {
  showLoading('Loading food packs…');
  await loadFoodPacks();
  hideLoading();
  showFoodPacks();
}

function addToCartFoodPack(fpId) {
  localAddItem('food_pack', fpId, 1);
  showToast('Added to cart!');
}

// ---------- Fixed cart bar (toggled) ----------
const CART_BAR_HIDDEN_VIEWS = ['cart', 'checkout', 'orders', 'order-detail', 'success'];
let cartBarOpen = false;

function toggleCartBar() {
  if (cart.items.length === 0) return;
  cartBarOpen = !cartBarOpen;
  renderCartBar();
}

function checkoutFromCartBar() {
  cartBarOpen = false;
  startCheckout();
}

/** Renders the fixed bottom bar; hidden when the cart is empty or a cart/orders screen is active. */
function renderCartBar() {
  const bar = $id('cart-bar');
  const app = $id('app');
  if (!bar || !app) return;
  const count = cart.items.reduce((s, i) => s + i.quantity, 0);
  const show = count > 0 && !CART_BAR_HIDDEN_VIEWS.includes(currentView);
  bar.classList.toggle('hidden', !show);
  bar.classList.toggle('open', show && cartBarOpen);
  app.classList.toggle('has-cart-bar', show);
  if (!show) return;

  const countEl = $id('cart-bar-count');
  if (countEl) countEl.textContent = count + ' item' + (count === 1 ? '' : 's') + ' in cart';
  const totalEl = $id('cart-bar-total');
  if (totalEl) totalEl.textContent = formatMoney(cart.totals.total);
  const chevron = $id('cart-bar-chevron');
  if (chevron) chevron.textContent = cartBarOpen ? '▾' : '▴';

  const details = $id('cart-bar-details');
  if (!details) return;
  if (cartBarOpen) {
    $id('cart-bar-items').innerHTML = cart.items.map((it) => {
      const unit = cartItemUnitPrice(it);
      const line = unit !== null && unit !== undefined ? unit * it.quantity : null;
      const comp = slotChoiceText(it);
      return `<div class="cart-bar-item">
        <div class="cbi-name">${esc(it.name)}${comp ? `<small>${esc(comp)}</small>` : ''}
          <small>Qty ${it.quantity}${unit !== null && unit !== undefined ? ' × ' + formatMoney(unit) : ''}</small>
        </div>
        <span class="cbi-price">${line !== null ? formatMoney(line) : '—'}</span>
        <button class="cbi-remove" onclick="removeCartItem(${it.id})" aria-label="Remove">✕</button>
      </div>`;
    }).join('');
    $id('cart-bar-grand').textContent = formatMoney(cart.totals.total);
    details.classList.remove('hidden');
  } else {
    details.classList.add('hidden');
  }
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
    (item.slot_choices || []).forEach((c) => { choices[Number(c.slot_number)] = Number(c.product_id); });
    return pricePackageChoices(pkg, choices, item.variant_size).total;
  }
  if (item.product_id) {
    const p = products.find((x) => Number(x.id) === Number(item.product_id));
    const vs = p ? productVariants(p) : [];
    const v = vs.find((x) => x.size === item.variant_size) || vs[0];
    return v ? Number(v.price) || 0 : null;
  }
  return null;
}

/** Composition text for package cart items, e.g. "Pork Rebozdo, Pancit Bam-i". */
function slotChoiceText(item) {
  if (!Array.isArray(item.slot_choices) || item.slot_choices.length === 0) return '';
  return item.slot_choices.map((c) => {
    const p = products.find((x) => Number(x.id) === Number(c.product_id));
    return p ? p.name : 'Item #' + c.product_id;
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
      const unit = cartItemUnitPrice(item);
      const line = unit !== null && unit !== undefined ? unit * item.quantity : null;
      const composition = slotChoiceText(item);
      return `<div class="cart-item">
        <div class="item-info">
          <div class="item-name">${esc(item.name)}</div>
          ${composition ? `<div class="item-meta">${esc(composition)}</div>` : ''}
          ${unit !== null && unit !== undefined
            ? `<div class="item-price">${formatMoney(unit)} × ${item.quantity}${line !== null ? ` = <strong>${formatMoney(line)}</strong>` : ''}</div>`
            : `<div class="item-price">Qty: ${item.quantity}</div>`}
        </div>
        <div class="qty-controls">
          <button onclick="updateCartItem(${item.id}, ${item.quantity - 1})">−</button>
          <button onclick="updateCartItem(${item.id}, ${item.quantity + 1})">+</button>
        </div>
        <button class="remove-btn" onclick="removeCartItem(${item.id})">🗑️</button>
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
  if (Number(t.discount) > 0) lines += `<div class="total-row discount"><span>Savings</span><span>−${formatMoney(t.discount)}</span></div>`;
  lines += `<div class="total-row"><span>Subtotal</span><span>${formatMoney(t.subtotal)}</span></div>`;
  lines += `<div class="total-row"><span>Delivery</span><span>${formatMoney(t.delivery)}</span></div>`;
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
  it.quantity = next;
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
function startCheckout() {
  if (cart.items.length === 0) return showToast('Your cart is empty');
  const container = $id('checkout-form');
  if (!container) return;

  const pay = config.payment || {};
  const methods = [
    { id: 'cod', label: 'Cash on Delivery', desc: pay.cod || 'Pay in cash when your order arrives.' },
    { id: 'gcash', label: 'GCash', desc: pay.gcash || 'Pay via GCash.' },
    { id: 'bank', label: 'Bank Transfer', desc: pay.bank || 'Pay via bank transfer.' },
  ];

  container.innerHTML = `
    <div class="form-group">
      <label>Full Name</label>
      <input type="text" id="co-name" placeholder="Juan Dela Cruz">
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
      <textarea id="address" placeholder="House #, street, barangay, city"></textarea>
    </div>
    <div class="form-group">
      <label>Contact Number</label>
      <input type="tel" id="phone" placeholder="09XX-XXX-XXXX">
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
  if (btn) { btn.disabled = true; btn.textContent = 'Placing order…'; }
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
      }),
    });
  } catch (e) {
    hideLoading();
    if (btn) { btn.disabled = false; btn.textContent = 'Place Order'; }
    showToast((e && e.message) || 'Failed to place order');
    return;
  }
  hideLoading();

  if (result && result.ok) {
    clearLocalCart();
    const successLine = $id('success-order-number');
    if (successLine) {
      successLine.textContent = 'Order #' + result.order_number +
        (result.total !== undefined && result.total !== null ? ' · ' + formatMoney(result.total) : '');
    }
    showView('view-success');
    if (isInsideMessenger) setTimeout(() => closeWebview(), 4000);
  } else {
    if (btn) { btn.disabled = false; btn.textContent = 'Place Order'; }
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