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
// Full, branch-unfiltered catalogs — the display lists above are filtered to
// the customer's branch (activeBranch). Kept separate so changing branches
// (or re-opening the gate) never needs a re-fetch.
let allProducts = [];
let allPackages = [];
let allFoodPacks = [];
// Branches & the customer's detected branch (lowercase key, e.g. 'naga').
// Loaded from /api/webview/branches; activeBranch comes from the GPS/pin
// confirmed in the location gate (nearest branch center).
let branchCatalog = [];
let activeBranch = null;
let cart = { items: [], totals: { subtotal: 0, delivery: 0, discount: 0, total: 0, breakdown: [] } };
let orders = [];
let config = { payment: {}, contact: {} };
let isInsideMessenger = false;
let currentView = 'categories';
let currentCategoryId = null;
let productDetail = { productId: null, size: null, qty: 1 };
let packageDetail = { pkgId: null, choices: {}, size: 'M', qty: 1 };
let foodPackDetail = { fpId: null, pieces: 10 };
const FOOD_PACK_MIN_PIECES = 10;
let locationPermissionState = 'unknown';

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
  const headerCartBtn = $id('header-cart-btn');
  const count = cart.items.reduce((s, i) => s + i.quantity, 0);

  if (badge) {
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
  }

  if (headerBadge) {
    headerBadge.textContent = count;
    headerBadge.classList.toggle('hidden', count === 0);
  }
  // Screen readers announce the count through the button's label, not the
  // decorative (aria-hidden) badge.
  if (headerCartBtn) headerCartBtn.setAttribute('aria-label', 'Cart, ' + count + ' item' + (count === 1 ? '' : 's'));

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
    allProducts = Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[webview] /products via API failed:', e && e.message);
    const client = getSupabaseClient();
    if (!client) { allProducts = []; }
    else {
      try {
        const { data } = await client.from('products')
          .select('*, product_variants(*)')
          .eq('active', 1)
          .order('category_id, sort_order');
        allProducts = (data || []).map((p) => ({ ...p, variants: p.product_variants || [] }));
      } catch { allProducts = []; }
    }
  }
  products = allProducts; // replaced later by applyBranchFilter()
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
    allPackages = normalizePackages(Array.isArray(data) ? data : []);
  } catch (e) {
    console.warn('[webview] /packages via API failed:', e && e.message);
    const client = getSupabaseClient();
    if (!client) { allPackages = []; }
    else {
      try {
        const { data } = await client.from('packages')
          .select('*, package_slots:package_slots(*, package_options:package_options(*, products(name, photo_url)))')
          .eq('active', 1)
          .order('id');
        allPackages = normalizePackages(data || []);
      } catch { allPackages = []; }
    }
  }
  packages = allPackages; // replaced later by applyBranchFilter()
}

async function loadFoodPacks() {
  try {
    const data = await api('/food-packs');
    allFoodPacks = Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[webview] /food-packs via API failed:', e && e.message);
    const client = getSupabaseClient();
    if (!client) { allFoodPacks = []; }
    else {
      try {
        const { data } = await client.from('food_packs').select('*').eq('active', 1).order('sort_order');
        allFoodPacks = data || [];
      } catch { allFoodPacks = []; }
    }
  }
  foodPacks = allFoodPacks; // replaced later by applyBranchFilter()
}
// ---------- Branch filtering (GPS-detected) ----------
// The customer's branch is detected from the delivery location they confirm in
// the location gate (device GPS or map pin → nearest branch center via
// /api/webview/branches/nearest). Once known, the menu only shows products,
// packages and food packs available at that branch. Items with an empty
// branches list are available everywhere.

/** Client-side mirror of availableAtBranch() — item.branches may arrive as an
 *  array (REST) or a JSON/comma string (direct Supabase fallback). */
function clientAvailableAtBranch(item, branch) {
  if (!branch) return true;
  let list = item && item.branches;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = list.split(','); }
  }
  if (!Array.isArray(list) || list.length === 0) return true; // empty = all branches
  return list.map((b) => String(b).trim().toLowerCase()).includes(branch);
}

/** Apply the active branch to the display catalogs and re-render what's on screen. */
function applyBranchFilter() {
  const b = activeBranch;
  products = b ? allProducts.filter((p) => clientAvailableAtBranch(p, b)) : allProducts;
  packages = b ? allPackages.filter((p) => clientAvailableAtBranch(p, b)) : allPackages;
  foodPacks = b ? allFoodPacks.filter((f) => clientAvailableAtBranch(f, b)) : allFoodPacks;
  console.log('[webview] branch filter applied →', b, {
    products: products.length, packages: packages.length, foodPacks: foodPacks.length,
  });
  // Re-render whatever is currently visible so the change is immediate.
  renderCategories();
  if (currentView === 'products' && currentCategoryId) showProducts(currentCategoryId);
  else if (currentView === 'packages') showPackages();
  else if (currentView === 'foodpacks') showFoodPacks();
}

/** Ask the server which branch serves these coordinates, switch to it and
 *  filter the menu. Returns the branch key (or null when it can't be resolved). */
async function detectBranchFromCoords(lat, lng) {
  try {
    const data = await api('/branches/nearest?lat=' + encodeURIComponent(lat) + '&lng=' + encodeURIComponent(lng));
    const branch = data && data.branch ? String(data.branch).toLowerCase() : null;
    if (branch && branch !== activeBranch) {
      activeBranch = branch;
      storageSet('webview_branch_' + sessionId, branch);
      applyBranchFilter();
    }
    return branch;
  } catch (e) {
    console.warn('[webview] /branches/nearest failed — showing all items:', e && e.message);
    return null;
  }
}

/** Branch banner text for the home header (null when no branch is active). */
function activeBranchName() {
  if (!activeBranch) return null;
  const entry = (branchCatalog || []).find((b) => b.key === activeBranch);
  return entry ? entry.name : activeBranch.charAt(0).toUpperCase() + activeBranch.slice(1);
}

/** Detect the branch straight from the device GPS (no location gate needed).
 *  Used at first load so the menu is filtered to the customer's branch BEFORE
 *  they confirm their delivery address. Never blocks the menu: resolves to the
 *  branch key (or null) and applies the filter when detection succeeds.
 * 
 *  IMPORTANT: This function can use IP fallback for approximate branch detection
 *  because it's only for menu filtering, NOT for delivery location. The delivery
 *  location must always come from GPS or map pin (user's explicit confirmation). */
async function detectBranchFromDeviceGps() {
  try {
    // Try GPS first
    try {
      const position = await LocationService.getGPSPosition();
      
      if (position && LocationService.isValidLocation(position)) {
        const branch = await detectBranchFromCoords(position.lat, position.lng);
        if (branch) {
          showToast('🏬 Showing the ' + (activeBranchName() || branch) + ' menu');
        }
        return branch;
      }
    } catch (gpsError) {
      console.warn('[webview] GPS branch detection failed, trying IP fallback:', gpsError.code);
    }
    
    // IP fallback for approximate branch detection only (NOT for delivery location)
    // IP geolocation returns ISP location, which is only approximate but enough for menu filtering
    const ipPosition = await LocationService.getIPBasedLocation();
    
    if (ipPosition && LocationService.isValidLocation(ipPosition)) {
      const branch = await detectBranchFromCoords(ipPosition.lat, ipPosition.lng);
      if (branch) {
        const city = ipPosition.city ? ' near ' + ipPosition.city : '';
        showToast('🏬 Showing the ' + (activeBranchName() || branch) + ' menu (approximate' + city + ')');
      }
      return branch;
    }
    
    return null;
    
  } catch (err) {
    console.warn('[webview] branch detection failed completely:', err.code, err.message);
    return null;
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
  // Hours render in the contact strip + "Visit us" card — the header no
  // longer duplicates them.

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
  // Category rail removed — customers now land on the packages-first home.
  renderCategorySections();
  renderBestValueCarousel();
  renderByopSection();
  const pf = $id('promo-foodpacks');
  if (pf) pf.textContent = foodPacks.length > 0
    ? foodPacks.length + ' pack' + (foodPacks.length === 1 ? '' : 's') + ' available'
    : 'No food packs right now';
}

/** Render the Best Value packages carousel at the top of the home menu. */
function renderBestValueCarousel() {
  const section = $id('best-value-section');
  const carousel = $id('best-value-carousel');
  if (!section || !carousel) return;
  // Exclude the "Build Your Own" custom package — it gets its own dedicated
  // section at the bottom of the home menu.
  const fixed = packages.filter((pkg) => !pkg.is_custom);
  if (fixed.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  carousel.innerHTML = fixed.map((pkg) => {
    const img = imageHtml(pkg.photo_url, pkg.name);
    const desc = pkg.description ? `<div class="pkg-desc">${esc(pkg.description)}</div>` : '';
    const price = packageCardPrice(pkg, cardSizes['package-' + pkg.id]);
    return `<div class="pkg-card" onclick="showPackageDetail(${pkg.id})">
      ${img}
      <div class="pkg-info">
        <div class="pkg-name">${esc(pkg.name)}</div>
        ${desc}
        <div class="pkg-price-row">
          <span class="pkg-price">${price}</span>
          <button class="pkg-add-btn" onclick="addToCartPackageQuick(${pkg.id}, event)">+ Add</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

/** Render the "Build Your Own Package" section at the bottom of the home menu. */
function renderByopSection() {
  const section = $id('byop-home-section');
  const card = $id('byop-home-card');
  if (!section || !card) return;
  const byop = packages.find((pkg) => pkg.is_custom);
  if (!byop) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  const img = imageHtml(byop.photo_url, byop.name);
  const price = packageCardPrice(byop, cardSizes['package-' + byop.id]);
  card.innerHTML = `
    <div class="byop-home-card-inner" onclick="showPackageDetail(${byop.id})">
      ${img}
      <div class="byop-home-info">
        <div class="byop-home-name">${esc(byop.name)}</div>
        ${byop.description ? `<div class="byop-home-desc">${esc(byop.description)}</div>` : ''}
        <div class="byop-home-price-row">
          <span class="byop-home-price">${price}</span>
          <button class="byop-home-add-btn" onclick="addToCartPackageQuick(${byop.id}, event)">+ Add to Cart</button>
        </div>
      </div>
    </div>`;
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
 * extraCls adds a modifier class, e.g. 'fp-card' for the horizontal rail.
 * Layout: media block on top (photo + circular quick-add pinned to its corner,
 * or a sold-out overlay), then name / description / size pills / price row.
 * JS-facing hooks kept intact: .product-card, .size-pill, .card-price. */
function productCardHtml(p, extraCls) {
  const unavailable = Number(p.unavailable) === 1;
  const vs = productVariants(p);
  const selSize = cardSizes['product-' + p.id] || (vs[0] ? vs[0].size : null);
  // Sizes on their own row between description and price — keeps the price row
  // uncluttered and the tap targets roomy.
  const sizePills = vs.length > 1
    ? vs.map((v) =>
      `<button class="size-pill${v.size === selSize ? ' selected' : ''}" onclick="selectCardSize(event, 'product', ${p.id}, '${esc(v.size)}')">${esc(v.size)}</button>`
    ).join('')
    : '';
  return `<div class="product-card${extraCls ? ' ' + extraCls : ''}${unavailable ? ' unavailable' : ''}" ${unavailable ? '' : `onclick="showProductDetail(${p.id})"`}>
    <div class="card-media">
      ${imageHtml(p.photo_url, p.name)}
      ${unavailable
        ? '<div class="soldout-overlay"><span>Sold out</span></div>'
        : `<button type="button" class="card-add-btn" aria-label="Add ${esc(p.name)} to cart" onclick="addToCartProductQuick(${p.id}, event)">＋</button>`}
    </div>
    <div class="info">
      <div class="name">${esc(p.name)}</div>
      ${p.description ? `<div class="desc">${esc(p.description)}</div>` : ''}
      ${sizePills ? `<div class="card-sizes">${sizePills}</div>` : ''}
      <div class="price-row">
        <span class="price card-price">${productCardPrice(p, selSize)}</span>
        ${unavailable ? '<span class="unavailable-note">Currently unavailable</span>' : ''}
      </div>
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
      <div class="card-media">${imageHtml(pkg.photo_url, pkg.name)}</div>
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
    <div class="form-group" id="delivery-fee-group" style="display:none">
      <div class="total-row"><span>🛵 Delivery Fee</span><span class="value" id="delivery-fee-val">—</span></div>
    </div>
    <div class="total-row grand" style="margin:12px 0"><span>Order Total</span><span class="value" id="co-total-val">${formatMoney(cart.totals.total)}</span></div>
    <button class="btn btn-primary btn-checkout" id="place-order-btn" onclick="placeOrder()">Place Order</button>
  `;

  $id('order-type').addEventListener('change', function () {
    $id('address-group').style.display = this.value === 'delivery' ? 'block' : 'none';
    updateDeliveryFeeRow();
  });
  $id('fulfill-date').addEventListener('change', function () { loadTimeSlots(this.value); });

  const today = new Date().toISOString().split('T')[0];
  $id('fulfill-date').setAttribute('min', today);
  updateDeliveryFeeRow();
  showView('view-checkout');
}

// ---------- Delivery fee estimate (client mirror of the server engine) ----------
// ₱50 base + ₱1 per 100 m from the nearest store origin to the confirmed pin.
function estimateDeliveryFee() {
  const loc = getSavedLocation();
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return null;
  let best = null, bestD = Infinity;
  for (const b of branchCatalog || []) {
    if (!Number.isFinite(b.lat) || !Number.isFinite(b.lng)) continue;
    const dLat = b.lat - loc.lat;
    const dLng = (b.lng - loc.lng) * Math.cos((loc.lat * Math.PI) / 180);
    const d = dLat * dLat + dLng * dLng;
    if (d < bestD) { bestD = d; best = b; }
  }
  if (!best) return null;
  const dx = (best.lng - loc.lng) * 111320 * Math.cos((loc.lat * Math.PI) / 180);
  const dy = (best.lat - loc.lat) * 110574;
  const meters = Math.sqrt(dx * dx + dy * dy);
  return { fee: 50 + Math.ceil(meters / 100), km: Math.round(meters / 100) / 10 };
}

/** Show/hide the delivery-fee row and refresh the grand total in checkout. */
function updateDeliveryFeeRow() {
  const group = $id('delivery-fee-group');
  const val = $id('delivery-fee-val');
  const total = $id('co-total-val');
  if (!group || !val || !total) return;
  const type = $id('order-type') ? $id('order-type').value : 'delivery';
  if (type !== 'delivery') {
    group.style.display = 'none';
    total.textContent = formatMoney(cart.totals.total);
    return;
  }
  const est = estimateDeliveryFee();
  group.style.display = '';
  if (est) {
    val.textContent = formatMoney(est.fee) + ' (est. ' + est.km + ' km)';
    total.textContent = formatMoney(cart.totals.total + est.fee);
  } else {
    val.textContent = 'Set location first';
    total.textContent = formatMoney(cart.totals.total);
  }
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

  // Attach the confirmed location's coordinates so the server can compute the
  // distance-based delivery fee AND generate the rider's Waze link. The keys
  // MUST match the server's expected `delivery_lat` / `delivery_lng`.
  const savedLoc = getSavedLocation();
  const orderCoords = (savedLoc && savedLoc.lat != null && savedLoc.lng != null)
    ? { delivery_lat: savedLoc.lat, delivery_lng: savedLoc.lng }
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

/** True on Android's system WebView / Custom Tabs / in-app browsers (NOT full
 *  Chrome). These swallow the geolocation prompt: the API object exists but
 *  callbacks never fire, so GPS can never succeed there. */
function isAndroidWebView() {
  try {
    const ua = navigator.userAgent || '';
    if (!/Android/i.test(ua)) return false;
    // Full Chrome on Android: "... Chrome/xx ... Safari/537.36" WITHOUT "; wv".
    // WebViews add "; wv" (Lollipop+) or lack "Chrome/" + "Safari/" entirely
    // (older webviews, Custom Tabs wrappers, FB_IAB).
    if (/;\s*wv\)/i.test(ua)) return true;
    if (/\bVersion\/\d+.*Chrome\//i.test(ua)) return true; // classic WebView token
    if (/\b(FBAV|FB_IAB|FBAN|Orca-Android)\b/i.test(ua)) return true;
    // No Chrome token at all on Android = some embedded webview.
    if (!/Chrome\//i.test(ua) && /Safari\/|Mozilla\//i.test(ua)) return true;
    return false;
  } catch (e) { return false; }
}

/** Probe whether this browser will EVER answer a geolocation request.
 *  Android WebViews famously expose navigator.geolocation but never invoke
 *  either callback. A throwaway 2.5s probe answers the question fast so we
 *  can skip the doomed 30s GPS run and send the user straight to the map.
 *  Resolves true = provider answered (GPS will work), false = dead end. */
function probeGpsProvider() {
  return new Promise((resolve) => {
    try {
      if (!navigator.geolocation || !window.isSecureContext) { resolve(false); return; }
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const timer = setTimeout(() => finish(false), 2500);
      if (timer && typeof timer.unref === 'function') { try { timer.unref(); } catch (e) {} }
      navigator.geolocation.getCurrentPosition(
        () => { clearTimeout(timer); finish(true); },
        () => { clearTimeout(timer); finish(true); }, // ANY answer (even denial) = alive
        { enableHighAccuracy: false, timeout: 2000, maximumAge: 60000 }
      );
    } catch (e) { resolve(false); }
  });
}

/** "Open in Chrome" escape hatch for Android WebViews where GPS can never
 *  work (app-level location permission off / prompt swallowed). Tries a
 *  one-tap intent:// open in full Chrome; falls back to copying the page URL
 *  so the user can paste it into Chrome, where GPS works. */
function openInChrome() {
  try {
    const url = location.href;
    const noScheme = url.replace(/^https?:\/\//i, '');
    const intentUrl = 'intent://' + noScheme +
      '#Intent;scheme=' + (location.protocol === 'http:' ? 'http' : 'https') +
      ';package=com.android.chrome;S.browser_fallback_url=' +
      encodeURIComponent(url) + ';end';
    try { if (typeof gpsLog === 'function') gpsLog('opening in Chrome via intent', 'dbg-warn'); } catch (e) {}
    window.location.href = intentUrl;
  } catch (e) {}
}

function showOpenInBrowserHelp() {
  try {
    const url = location.href;
    const ua = navigator.userAgent || '';
    const isAndroid = /Android/i.test(ua);
    // Show the one-tap button (declared in index.html) on Android only.
    try {
      const btn = document.getElementById('loc-chrome-btn');
      if (btn) btn.classList.toggle('hidden', !isAndroid);
    } catch (e) {}
    // Best-effort copy so the user just pastes in Chrome if no Chrome app.
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).catch(() => {});
      } else {
        const ta = document.createElement('textarea');
        ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e2) {}
        ta.remove();
      }
    } catch (e) {}
    showLocError(isAndroid
      // Location help copies — the native share is gone, so copy mentions a Google
// Maps link where relevant.
      ? 'No GPS here — Messenger is blocked from asking for location. Share a Google Maps link in this chat (or tap "Open in Chrome" below), then reopen the store. Or just tap your spot on the map.'
      : 'GPS is blocked inside this in-app browser. Link copied — open Chrome, paste it there, and tap "Use my current location". Or just tap your spot on the map below.');
  } catch (e) {}
}

/** Wait up to ~2s for the MessengerExtensions SDK, then resolve detection. */
async function detectMessenger() {
  if (window.__messengerExtensionsReady) return true;
  if (window.MessengerExtensions && typeof window.MessengerExtensions.isInExtension === 'function') {
    try { if (window.MessengerExtensions.isInExtension()) return true; } catch { /* ignore */ }
  }
  // Check if opened via Messenger button with psid parameter
  try { if (new URLSearchParams(window.location.search).get('psid')) return true; } catch { /* ignore */ }

  for (let i = 0; i < 10; i++) {
    if (window.__messengerExtensionsReady) return true;
    if (window.MessengerExtensions && typeof window.MessengerExtensions.isInExtension === 'function') {
      try { if (window.MessengerExtensions.isInExtension()) return true; } catch { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return detectMessengerUserAgent();
}

/** Android WebView / Messenger in-app browser: GPS prompts are routinely
 *  swallowed, so pre-warming the permission state + geolocation provider in
 *  the background makes the real tap resolve fast instead of hanging.
 *  Never shows UI, never blocks — failures are silently ignored. */
function warmUpGpsProvider() {
  try {
    if (typeof LocationService !== 'undefined' && LocationService.queryPermissionState) {
      LocationService.queryPermissionState().catch(() => {});
    }
    if (!navigator.geolocation || !window.isSecureContext) return;
    // A throwaway low-accuracy shot warms the OS provider cache. Short
    // timeout, cached answers welcome — this is warmup, not a fix.
    navigator.geolocation.getCurrentPosition(() => {}, () => {}, {
      enableHighAccuracy: false, timeout: 8000, maximumAge: 60000,
    });
  } catch (e) { /* warmup must never break the page */ }
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

// --- Leaflet + OpenStreetMap + Nominatim ---
// Map pin picker uses Leaflet with free OpenStreetMap tiles (no API key).
// Address search + reverse geocoding use the free Nominatim service.
// Routing/distance for the future delivery fee will use OSRM.
// Leaflet is loaded dynamically so a blocked CDN degrades to address-only.
let locMap = null;
let locMarker = null;
let mapInitFailed = false;

/** Leaflet is included statically in index.html. This waits until it is
 *  available (or times out → graceful address-only fallback). */
function loadLeaflet() {
  return new Promise((resolve) => {
    if (typeof L !== 'undefined' && L.map) { resolve(true); return; }
    const started = Date.now();
    const poll = () => {
      if (typeof L !== 'undefined' && L.map) {
        resolve(true);
        return;
      }
      if (Date.now() - started > 8000) {
        console.warn('[webview] Leaflet not available — falling back to address-only mode');
        mapInitFailed = true;
        resolve(false);
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

/** Saved delivery location for this session (or null when not set yet). */
function getSavedLocation() {
  try {
    const loc = JSON.parse(storageGet(LOCATION_KEY()) || 'null');
    return loc && loc.address ? loc : null;
  } catch { return null; }
}

// ---------- Saved locations (multiple addresses per customer) ----------
// Every confirmed location is kept in a per-session list so returning
// customers can re-select one with a single tap instead of re-entering it.
// The single LOCATION_KEY entry stays in sync as "the location in use".
const LOCATIONS_KEY = () => 'webview_locations_' + sessionId;
const MAX_SAVED_LOCATIONS = 10;

function getSavedLocations() {
  try {
    const list = JSON.parse(storageGet(LOCATIONS_KEY()) || '[]');
    return Array.isArray(list) ? list.filter((l) => l && l.address) : [];
  } catch { return []; }
}

/** Numeric coords of a location (null when absent/malformed — tolerant of
 *  string coords coming from older records or the server). */
function locationCoords(loc) {
  const lat = Number(loc.lat);
  const lng = Number(loc.lng);
  return (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0))
    ? { lat, lng } : null;
}

/** Approximate distance in meters between two coordinate pairs (equirectangular
 *  — plenty accurate for the small distances we compare). */
function coordsDistanceMeters(a, b) {
  const R = 6371000;
  const rad = (d) => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng) * Math.cos(rad((a.lat + b.lat) / 2));
  return Math.sqrt(dLat * dLat + dLng * dLng) * R;
}

// Points closer than this count as the same place when deduping saved
// locations. GPS jitter moves the fix by meters on every confirm, so exact
// coordinate equality (the old signature) duplicated the same address.
const DEDUPE_RADIUS_METERS = 75;

/** True when two saved records describe the same place: identical normalized
 *  address, or both points within DEDUPE_RADIUS_METERS of each other. */
function samePlace(a, b) {
  const addrA = String(a.address || '').trim().toLowerCase();
  const addrB = String(b.address || '').trim().toLowerCase();
  if (addrA && addrA === addrB) return true;
  const cA = locationCoords(a);
  const cB = locationCoords(b);
  if (cA && cB) return coordsDistanceMeters(cA, cB) <= DEDUPE_RADIUS_METERS;
  return false;
}

function saveLocation(loc) {
  // "In use" location — kept for branch detection, checkout, pin restore.
  try { storageSet(LOCATION_KEY(), JSON.stringify(loc)); } catch { /* non-fatal */ }
  // Append/update in the saved-locations list, deduped by place (same address
  // or points within DEDUPE_RADIUS_METERS) so GPS jitter, string-vs-number
  // coords and hand-typed variants can't create duplicate records.
  try {
    const list = getSavedLocations();
    const coords = locationCoords(loc);
    const existingIdx = list.findIndex((l) => samePlace(l, loc));
    const prev = existingIdx >= 0 ? list[existingIdx] : null;
    const entry = {
      id: prev ? prev.id : 'loc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      address: String(loc.address || '').trim(),
      landmark: loc.landmark || (prev ? prev.landmark : null) || null,
      // New coords win; keep the previous fix when this save has none
      // (e.g. an address-only re-confirm must not lose the pin).
      lat: coords ? coords.lat : (prev ? locationCoords(prev)?.lat ?? null : null),
      lng: coords ? coords.lng : (prev ? locationCoords(prev)?.lng ?? null : null),
      source: loc.source || (prev ? prev.source : null) || 'manual',
      label: loc.label || (prev ? prev.label : null) || null,
      savedAt: prev ? prev.savedAt : new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    if (existingIdx >= 0) list[existingIdx] = entry; else list.unshift(entry);
    // Most-recently-used first, capped so storage can't grow unbounded.
    list.sort((a, b) => String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || '')));
    // Collapse duplicates already sitting in storage (records created by
    // older versions whose signature broke on jitter / string coords).
    const deduped = [];
    for (const l of list) {
      const dupIdx = deduped.findIndex((d) => samePlace(d, l));
      if (dupIdx >= 0) {
        const keep = String(l.lastUsedAt || '') > String(deduped[dupIdx].lastUsedAt || '')
          ? l.lastUsedAt : deduped[dupIdx].lastUsedAt;
        deduped[dupIdx].lastUsedAt = keep;
      } else {
        deduped.push(l);
      }
    }
    storageSet(LOCATIONS_KEY(), JSON.stringify(deduped.slice(0, MAX_SAVED_LOCATIONS)));
  } catch { /* non-fatal */ }
}

/** Persist a label for a saved location ("Home", "Office", …). */
function renameSavedLocation(id, label) {
  try {
    const list = getSavedLocations();
    const entry = list.find((l) => l.id === id);
    if (entry) {
      entry.label = (label || '').trim() || null;
      storageSet(LOCATIONS_KEY(), JSON.stringify(list));
      renderSavedLocations();
    }
  } catch { /* non-fatal */ }
}

/** Remove a saved address from the list (does not affect the in-use location). */
function removeSavedLocation(id) {
  try {
    storageSet(LOCATIONS_KEY(), JSON.stringify(getSavedLocations().filter((l) => l.id !== id)));
    renderSavedLocations();
    showToast('🗑️ Saved location removed');
  } catch { /* non-fatal */ }
}

/** Render the saved-location chips inside the gate. Tap = use immediately. */
function renderSavedLocations() {
  const wrap = $id('loc-saved');
  const listEl = $id('loc-saved-list');
  if (!wrap || !listEl) return;
  const list = getSavedLocations();
  if (!list.length) { wrap.classList.add('hidden'); listEl.innerHTML = ''; return; }
  wrap.classList.remove('hidden');
  listEl.innerHTML = list.map((l) => {
    const title = esc(l.label || l.address);
    const sub = l.label ? esc(l.address) : '';
    return `<div class="loc-saved-chip" onclick="useSavedLocation('${esc(l.id)}')">
      <span class="loc-saved-icon">📍</span>
      <span class="loc-saved-text"><strong>${title}</strong>${sub ? `<small>${sub}</small>` : ''}</span>
      <button type="button" class="loc-saved-del" aria-label="Remove" onclick="event.stopPropagation(); removeSavedLocation('${esc(l.id)}')">✕</button>
    </div>`;
  }).join('');
}

// Menu is revealed ONLY after the customer's branch is known — the catalogs
// are fetched up front, but nothing is rendered until location data resolves
// (saved coords, device GPS, or IP) or the customer confirms a location in the
// gate. revealMenu() is idempotent (safe to call on every confirm).
let menuRevealed = false;

/** First-time reveal of the menu once the branch is known (or on explicit
 *  confirm). Renders the filtered catalogs and unlocks the home view. */
function revealMenu() {
  if (menuRevealed) return;
  const mainContent = $id('main-content');
  const nav = $id('bottom-nav');
  if (categories.length === 0) {
    hideLoading();
    if (mainContent) mainContent.classList.add('hidden');
    if (nav) nav.style.display = 'none';
    const errBox = $id('load-error');
    if (errBox) errBox.classList.remove('hidden');
    return;
  }
  hideLoading();
  if (mainContent) mainContent.classList.remove('hidden');
  if (nav) nav.style.display = '';
  renderCategories();
  showCategories();
  menuRevealed = true;
}

// ---------- Header auto-hide on scroll ----------
// Standard mobile pattern: scrolling down hides the sticky header (more content
// space); scrolling up (or reaching the top) slides it back in. A small
// threshold prevents jitter from tiny finger movements / momentum scroll.
let headerLastY = 0;
let headerHideTick = false;

function setHeaderHidden(hidden) {
  const h = $id('site-header');
  if (!h) return;
  h.classList.toggle('header-hidden', !!hidden);
}

/** Header interactions: the logo is the "menu home" button — back to the
 *  categories view and scroll to the top (also re-shows the header). */
function initHeaderActions() {
  const logoBtn = $id('header-logo-btn');
  if (!logoBtn || logoBtn.dataset.bound) return;
  logoBtn.dataset.bound = '1';
  logoBtn.addEventListener('click', () => {
    showCategories();
    forceHeaderVisible();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

function initHeaderAutoHide() {
  const h = $id('site-header');
  if (!h) return;
  window.addEventListener('scroll', () => {
    if (headerHideTick) return; // throttle to one check per frame
    headerHideTick = true;
    requestAnimationFrame(() => {
      headerHideTick = false;
      const y = window.scrollY || window.pageYOffset || 0;
      const delta = y - headerLastY;
      const THRESHOLD = 12; // px of deliberate scrolling before reacting

      // Near the top → always show (so the brand/location bar stays visible).
      if (y < 60) {
        setHeaderHidden(false);
        h.classList.remove('header-scrolled');
      } else {
        h.classList.add('header-scrolled');
        // Only act on deliberate movement past the threshold.
        if (Math.abs(delta) > THRESHOLD) {
          setHeaderHidden(delta > 0); // down → hide, up → show
          headerLastY = y;
        }
      }
    });
  }, { passive: true });
}

// The header must always be visible under overlays (location gate, cart view,
// lightboxes) — showLocationGate/hideLocationGate call this to force it back.
function forceHeaderVisible() {
  setHeaderHidden(false);
  headerLastY = window.scrollY || 0;
}

// ---------- Header delivery-location bar ----------
/** Short display text for the header bar: label if set, else a trimmed address. */
function locationDisplayText(loc) {
  if (!loc || !loc.address) return null;
  if (loc.label) return loc.label;
  const a = String(loc.address).trim();
  return a.length > 42 ? a.slice(0, 42).trimEnd() + '…' : a;
}

/** Reflect the active delivery location in the header bar. */
function updateLocationBar() {
  const bar = $id('loc-bar');
  const addrEl = $id('loc-bar-address');
  const labelEl = $id('loc-bar-label');
  if (!bar || !addrEl) return;
  const loc = getSavedLocation();
  const text = locationDisplayText(loc);
  if (text) {
    addrEl.textContent = text;
    if (labelEl) labelEl.textContent = 'Deliver to';
    bar.classList.add('has-location');
  } else {
    addrEl.textContent = 'Set your delivery location';
    if (labelEl) labelEl.textContent = 'No location yet';
    bar.classList.remove('has-location');
  }
}

/** Change delivery location — re-opens the location gate (which now shows the
 *  customer's saved addresses for one-tap switching, plus GPS/map/manual entry
 *  for a brand-new address). Works from anywhere in the app. */
function changeDeliveryLocation() {
  showLocationGate();
}

/** Tap a saved address → apply it and confirm right away (unlock the menu). */
async function useSavedLocation(id) {
  const loc = getSavedLocations().find((l) => l.id === id);
  if (!loc) return;
  saveLocation(loc); // bumps lastUsedAt + sets it as the in-use location
  pendingCoords = (Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) ? { lat: loc.lat, lng: loc.lng } : null;
  pinSource = pendingCoords ? (loc.source === 'gps' ? 'gps' : 'pin') : null;
  hideLocError();
  // Mirror confirmLocation()'s post-save work without re-validating fields.
  const confirmedLat = pendingCoords ? pendingCoords.lat : null;
  const confirmedLng = pendingCoords ? pendingCoords.lng : null;
  pendingCoords = null;
  pinSource = null;
  hideLocationGate();
  updateLocationBar();
  showToast('📍 Delivering to ' + (loc.label ? loc.label : 'your saved location'));
  if (Number.isFinite(confirmedLat) && Number.isFinite(confirmedLng)) {
    const branch = await detectBranchFromCoords(confirmedLat, confirmedLng);
    if (branch) showToast('🏬 Showing the ' + (activeBranchName() || branch) + ' menu');
  }
  // Catalog not loaded yet (startup loaders failed or were slow)? Re-attempt
  // now — the old code jumped straight to revealMenu(), which with empty
  // catalogs showed the permanent "load error" screen instead of recovering.
  if (categories.length === 0 && products.length === 0) {
    await loadAppData();
  }
  // Filter to the active branch (also re-renders the current view), then
  // unlock home. Filter runs AFTER loadAppData() because the loaders reset
  // products = allProducts.
  applyBranchFilter();
  revealMenu();
}


/** Approximate the customer's position from their IP address (free ipwho.is
 *  service, no key). City-level accuracy — enough to pick the nearest branch
 *  when device GPS is unavailable (common in Messenger's in-app browser and
 *  Android WebView where the geolocation prompt is often blocked). */
function ipLocate() {
  return new Promise((resolve) => {
    const finish = (v) => resolve(v);
    try {
      fetch('https://ipwho.is/', { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => {
          const lat = Number(d && d.latitude);
          const lng = Number(d && d.longitude);
          if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
            finish({ lat, lng, city: (d.city && String(d.city)) || null, source: 'ip' });
          } else {
            finish(null);
          }
        })
        .catch(() => finish(null));
      // Hard cap so a hung request can't block the gate.
      setTimeout(() => finish(null), 6000);
    } catch { finish(null); }
  });
}

/** True when Leaflet loaded and the map was initialized successfully.
 * When false, the customer can still confirm with address-only — delivery fee
 * will fall back to a default/zone rate instead of a distance-based one. */
function mapAvailable() {
  return typeof L !== 'undefined' && !!locMap && !mapInitFailed;
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
  // Prefill the resolved address from the address remembered at checkout or
  // the previously saved gate location, so repeat customers only need to
  // re-confirm (or adjust the pin / landmark).
  const remembered = loadCustomerData();
  const saved = getSavedLocation();
  pendingAddress = null;
  pendingAddressFromUser = false;
  setPendingAddress((remembered && remembered.address) || (saved && saved.address) || null);
  // Returning customer → show their saved addresses for one-tap selection.
  renderSavedLocations();
  forceHeaderVisible(); // never let the header hide while the gate is open
  gate.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  const wrap = document.querySelector('.loc-map-wrap');
  if (wrap) wrap.style.display = '';

  // Inside Messenger (and Android webviews above all) the browser GPS prompt
  // can never appear — surface the chat link-share (Google Maps / Waze link
  // pasted in chat) as a first-class alternative right next to the GPS button.
  try {
    const chatBtn = $id('loc-chat-btn');
    if (chatBtn) {
      const inMessenger = (typeof detectMessengerUserAgent === 'function' && detectMessengerUserAgent()) || isAndroidWebView();
      chatBtn.classList.toggle('hidden', !inMessenger);
    }
  } catch (e) {}

  // If this chat already has a location saved server-side (native chat share
  // or an earlier confirm), prefill the pin so Android users don't have to
  // fiddle with GPS at all — just verify and Confirm.
  loadChatLocationIntoGate(saved);

  // Load Leaflet dynamically (no-op if already loaded). Once ready, initialize
  // the map. If loading fails, fall back to address-only.
  loadLeaflet().then((ok) => {
    if (ok) {
      initLeafletMap(); // creates locMap; its catch hides the map + shows the fallback
      // Restore the saved pin so returning customers see their spot.
      if (saved && saved.lat != null && saved.lng != null && locMap) {
        setMapPin({ lat: saved.lat, lng: saved.lng }, false);
        locMap.setView([saved.lat, saved.lng], 15);
      }
      // Auto-detect AFTER map is ready so we can pan to location
      autoDetectLocation();
    } else {
      if (wrap) wrap.style.display = 'none';
      showLocError('Map unavailable — please enter your address manually below.');
      // Still try auto-detect even without map (will just fill address)
      autoDetectLocation();
    }
  });

  // Wire up Nominatim address search on the search box.
  const searchEl = $id('loc-search');
  if (searchEl && !searchEl.dataset.locBound) {
    searchEl.dataset.locBound = '1';
    initSearchAutocomplete();
  }
  updateLocConfirmState();
}

// ---------- Robust GPS locator ----------
// One shared path for BOTH the automatic attempt when the gate opens and the
// manual "Use my current location" button. Everything funnels through
// LocationService.getCurrentPosition() (real GPS only — IP coordinates are
// never used for delivery) and handles the full failure surface with
// actionable UI: per-code status messaging, an inline retry button, per-
// platform "how to enable location" steps, an accuracy readout and coarse-fix
// warnings. The map pin + manual address entry remain the guaranteed
// fallbacks (Messenger's in-app browser, plain-HTTP origins, no GPS hardware).

// Fixes worse than this many meters are labelled "approximate" — the customer
// must verify/drag the pin before confirming. Mirrors LocationService.CONFIG.
const GPS_COARSE_METERS = (typeof LocationService !== 'undefined' && LocationService.CONFIG)
  ? LocationService.CONFIG.MAX_ACCURACY_METERS : 3000;

let gpsLocateBusy = false;
let gpsLocateStartedAt = 0; // timestamp of the in-flight run (stuck-busy guard)
let gpsRerunManual = false; // manual tap that arrived while the auto attempt held the lock
let gpsBarHideTimer = null;
let gpsElapsedTimer = null; // ticks the "Getting your location… (Xs)" label so phones feel alive

/** Live fix progress from LocationService: show the improving accuracy while
 *  the watch refines the fix (phones often sit 10-25s here). Never settles
 *  anything — purely the status text. */
window.__gpsProgress = function (coords) {
  try {
    if (!gpsLocateBusy) return;
    const acc = coords && Number(coords.accuracy);
    if (!Number.isFinite(acc) || acc <= 0) return;
    if (acc <= 60) return; // about to resolve as precise — let the success UI speak
    setLocateBar(null, 'Improving accuracy (±' + Math.round(acc) + ' m)… hold on');
    setAccuracyChip(acc);
  } catch (e) { /* progress must never break locating */ }
};

function gpsElapsedStart(viaAuto) {
  gpsElapsedStop();
  const t0 = Date.now();
  gpsElapsedTimer = setInterval(() => {
    try {
      if (!gpsLocateBusy) { gpsElapsedStop(); return; }
      const s = Math.round((Date.now() - t0) / 1000);
      const bar = $id('loc-autodetect');
      const mode = bar && bar.dataset ? bar.dataset.mode : '';
      if (mode === 'error' || mode === 'success') return; // a final state won — stop narrating
      const label = $id('loc-autodetect-label');
      if (!label) return;
      const txt = label.textContent || '';
      if (/Improving accuracy/i.test(txt)) return; // watch progress owns the label now
      label.textContent = (viaAuto ? 'Finding your location…' : 'Getting your location…') + ' (' + s + 's)';
    } catch (e) {}
  }, 1000);
  if (gpsElapsedTimer && typeof gpsElapsedTimer.unref === 'function') { try { gpsElapsedTimer.unref(); } catch (e) {} }
}

function gpsElapsedStop() {
  if (gpsElapsedTimer) { clearInterval(gpsElapsedTimer); gpsElapsedTimer = null; }
}

/** Sync the GPS button's visual state: idle | locating | success. */
function setGPSButtonState(state) {
  const btn = $id('loc-gps-btn');
  const label = $id('loc-gps-label');
  const icon = $id('loc-gps-icon');
  if (!btn) return;
  // NEVER hard-disable the button: a disabled button swallows taps silently
  // (no onclick at all), which is exactly the "dead button" during the ~30s
  // gate-open auto attempt. Keep it tappable; the busy guard in
  // useCurrentLocation() queues manual taps instead of dropping them.
  btn.disabled = false;
  btn.setAttribute('aria-disabled', state === 'locating' ? 'true' : 'false');
  btn.classList.toggle('is-locating', state === 'locating');
  btn.classList.toggle('is-success', state === 'success');
  if (label) {
    label.textContent = state === 'locating' ? 'Getting your location…'
      : state === 'success' ? 'Locate me again'
      : 'Use my current location';
  }
  if (icon) icon.textContent = state === 'locating' ? '⏳' : state === 'success' ? '✅' : '📍';
}

/** Locate status bar above the map. mode: '' | 'success' | 'neutral' | 'error'. */
function setLocateBar(mode, text) {
  const bar = $id('loc-autodetect');
  const label = $id('loc-autodetect-label');
  if (!bar || !label) return;
  clearTimeout(gpsBarHideTimer);
  bar.classList.remove('hidden', 'loc-autodetect-success', 'loc-autodetect-neutral', 'loc-autodetect-error');
  if (mode) bar.classList.add('loc-autodetect-' + mode);
  bar.dataset.mode = mode || '';
  label.textContent = text;
}

/** Accuracy readout chip ("±25 m") — green when precise, amber when coarse. */
function setAccuracyChip(accuracyMeters) {
  const chip = $id('loc-accuracy');
  if (!chip) return;
  const acc = Number(accuracyMeters);
  if (Number.isFinite(acc) && acc > 0) {
    chip.textContent = '±' + Math.round(acc) + ' m';
    chip.classList.toggle('good', acc <= 60);
    chip.classList.toggle('coarse', acc > GPS_COARSE_METERS);
    chip.classList.remove('hidden');
  } else {
    chip.classList.add('hidden');
  }
}

/** Format lat/lng for display — 5 decimals ≈ 1 m precision. */
function formatCoords(lat, lng) {
  return Number(lat).toFixed(5) + ', ' + Number(lng).toFixed(5);
}

/** Chosen point's coordinates under the map (set on a GPS fix / pin move). */
function setCoordsDisplay(lat, lng) {
  const el = $id('loc-coords');
  if (!el) return;
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    el.textContent = '🧭 ' + formatCoords(lat, lng);
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

/** Inline retry affordance inside the status bar (shown after failures). */
function setRetryVisible(visible) {
  const btn = $id('loc-retry-btn');
  if (btn) btn.classList.toggle('hidden', !visible);
}
/** Collapsible, per-platform "how to enable location" panel (Android/iOS/desktop). */
function showPermissionHelp() {
  const panel = $id('loc-perm-help');
  if (!panel) return;
  const title = $id('loc-perm-title');
  const steps = $id('loc-perm-steps');
  const guide = (typeof LocationService !== 'undefined' && LocationService.getPermissionGuidance)
    ? LocationService.getPermissionGuidance() : null;
  if (title && guide) title.textContent = guide.title;
  if (steps && guide) steps.innerHTML = guide.steps.map((s) => '<li>' + esc(s) + '</li>').join('');
  // Android WebView: surface the one-tap "Open in Chrome" button — the panel
  // alone can't fix an app-level block, the browser switch can.
  try {
    const chromeBtn = $id('loc-chrome-btn');
    if (chromeBtn) chromeBtn.classList.toggle('hidden', !isAndroidWebView());
  } catch (e) {}
  panel.classList.remove('hidden');
}

function hidePermissionHelp() {
  const panel = $id('loc-perm-help');
  if (panel) panel.classList.add('hidden');
  try {
    const chromeBtn = $id('loc-chrome-btn');
    if (chromeBtn) chromeBtn.classList.add('hidden');
  } catch (e) {}
}

/** Success path shared by the auto attempt and the button: remember the fix,
 *  pin + zoom the map, show accuracy, then reverse-geocode (best-effort). */
function applyGPSFix(position, wasAuto) {
  // Handoff (see useCurrentLocation): a manual tap arrived while the quiet
  // auto attempt was running — the auto fix just landed, so immediately run
  // one REAL manual attempt so the customer gets their explicit result
  // (fresh fix, full success/error UI) instead of a stale-looking outcome.
  if (wasAuto && gpsRerunManual) {
    gpsRerunManual = false;
    useCurrentLocation(false);
    return;
  }

  locationPermissionState = 'granted';
  locationPermissionState = 'granted';
  pendingCoords = { lat: position.lat, lng: position.lng };
  pinSource = 'gps';
  const acc = Number(position.accuracy);
  const isCoarse = Number.isFinite(acc) && acc > GPS_COARSE_METERS;

  setGPSButtonState('success');
  setRetryVisible(false);
  setAccuracyChip(acc);
  setCoordsDisplay(position.lat, position.lng);
  setLocateBar('success', isCoarse
    ? '✓ Approximate location found (' + formatCoords(position.lat, position.lng) + ') — drag the pin to fine-tune'
    : '✓ Location found (' + formatCoords(position.lat, position.lng) + ') — check it and confirm');
  // Let the success message sink in, then tuck the bar away.
  gpsBarHideTimer = setTimeout(() => {
    const bar = $id('loc-autodetect');
    if (bar) bar.classList.add('hidden');
  }, 2600);

  // Drop/zoom the pin (works even while the map is still initializing).
  zoomMapToPin(pendingCoords, 16, true, true);
  updateLocConfirmState();
  showToast(isCoarse
    ? '📍 Approximate location found — please verify it on the map'
    : '📍 Location found — check it and confirm');

  // Name the fix (reverse-geocode, best effort). Auto names never stomp an
  // explicit customer choice (search pick).
  reverseGeocode(position.lat, position.lng)
    .then((address) => {
      setPendingAddress(address);
      const searchEl = $id('loc-search');
      if (searchEl && !searchEl.value.trim()) searchEl.value = address;
    })
    .catch(() => {
      setLocateBar('success', isCoarse
        ? '✓ Position found — add a landmark below'
        : '✓ Location found — add a landmark below');
    });
}

/** TEMPORARY testing aid — timestamped GPS trace (REMOVE BEFORE PRODUCTION).
 *  gpsLog(line, cls): append one line; toggleGPSDebugLog/clearGPSDebugLog
 *  drive the collapsible panel. Auto-opens on the first logged line so the
 *  user never has to hunt for it mid-test. */
function gpsLog(line, cls) {
  try {
    const panel = $id('loc-debug');
    const box = $id('loc-debug-log');
    if (!box) return;
    if (panel && panel.classList.contains('hidden')) panel.classList.remove('hidden');
    const t = new Date();
    const ts = String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0') + '.' + String(t.getMilliseconds()).padStart(3, '0');
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = '[' + ts + '] ' + line;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    // Cap at 200 lines so a pathological run can't grow the DOM forever.
    while (box.children.length > 200) box.removeChild(box.firstChild);
  } catch (e) { /* logging must never break locating */ }
}
function toggleGPSDebugLog() {
  const panel = $id('loc-debug');
  if (panel) panel.classList.toggle('hidden');
}
function clearGPSDebugLog() {
  const box = $id('loc-debug-log');
  if (box) box.innerHTML = '';
}
/** TEMP bridge — exposes the debug logger to location-service.js stage
 *  traces (REMOVE WITH gpsLog BEFORE PRODUCTION). Signature:
 *  __gpsLog(line, cls, stage). */
window.__gpsLog = function (line, cls, stage) {
  gpsLog((stage ? '[' + stage + '] ' : '') + line, cls || undefined);
};

/** Failure path: per-code messaging + recovery affordances. The map tap and
 *  manual address entry remain available no matter what failed here. */
function handleGPSFailure(err, viaAuto) {
  // A manual "locate me" tap that arrived while the gate-open auto attempt
  // still held the lock is silently swallowed by the busy guard below — rerun
  // it as a REAL manual attempt (force:true + full error surface) instead of
  // leaving the customer staring at "Getting your location…" forever.
  if (viaAuto && gpsRerunManual) {
    gpsRerunManual = false;
    viaAuto = false;
  }

  const code = (err && err.code) || 'UNKNOWN_ERROR';
  const E = LocationService.ErrorCodes;
  locationPermissionState = code === E.PERMISSION_DENIED ? 'denied' : 'unavailable';
  setGPSButtonState('idle');
  setAccuracyChip(null);
  updateLocConfirmState(); // re-sync (hides a stale coordinate readout on manual failures)

  // Friendly, actionable status for each failure mode.
  // NOTE: on Android WebViews "no popup ever appears" is the signature of an
  // app-level block (Messenger app has no OS location permission) — the page
  // can NEVER fix that, so every branch below funnels to Open-in-Chrome + map.
  if (code === E.PERMISSION_DENIED) {
    setLocateBar('error', '📍 No location popup appeared — Messenger is blocked from asking. Open in Chrome below, or tap the map');
    // The quiet auto attempt just nudges; manual attempts get the full help.
    if (!viaAuto) {
      showPermissionHelp();
      try { if (isAndroidWebView()) showOpenInBrowserHelp(); } catch (e) {}
      if (!isAndroidWebView()) showLocError('Phone location is off or access is blocked. Enable Location Services and allow access, or tap the map below to set your location.');
    }
  } else if (code === E.TIMEOUT) {
    setLocateBar('error', '📍 Getting your location timed out — try again, or tap the map below');
    // Android WebView signature: full 30s silence = the prompt was swallowed
    // (app-level location off). Hand them the Chrome escape hatch, not a bare retry.
    if (!viaAuto) {
      try {
        if (isAndroidWebView()) showOpenInBrowserHelp();
      } catch (e) {}
    }
  } else if (code === E.POSITION_UNAVAILABLE || code === E.GPS_DISABLED) {
    // GPS_DISABLED = the fix failed almost instantly, which means the
    // phone's master Location switch is OFF (not a signal problem).
    const gpsOff = code === E.GPS_DISABLED;
    setLocateBar('error', gpsOff
      ? '📍 Phone location is OFF — turn on Location Services, then tap ↻ Retry'
      : '📍 Could not get your position — check that phone location is ON, or tap the map');
    if (gpsOff && !viaAuto) {
      showPermissionHelp();
      showLocError('Phone location is OFF. Turn on Location Services in your phone Settings, come back here and tap ↻ Retry — or tap your spot on the map below.');
    }
  } else if (code === E.API_UNSUPPORTED || code === E.SECURE_CONTEXT_REQUIRED) {
    setLocateBar('error', "📍 Location isn't available here — tap your spot on the map below");
  } else {
    setLocateBar('error', '📍 ' + ((err && err.message) || 'Could not get your location — try again or tap the map below'));
  }
  // Every failure except "no GPS support at all" is worth one retry tap.
  setRetryVisible(code !== E.API_UNSUPPORTED && code !== E.SECURE_CONTEXT_REQUIRED);
  console.warn('[webview] locate failed —', code, err && err.message);
  focusMap();
}

/** Locate the device. viaAuto = the quiet attempt on gate-open (no hard error
 *  popups — the map/manual fallbacks are shown instead); manual runs surface
 *  the full permission-help panel when access is blocked.
 *  iOS SAFARI NOTE: programmatic locate calls outside a user gesture may be
 *  silently ignored — the auto attempt is best-effort only; the GPS button
 *  tap IS the gesture, so it always carries the real request. */
async function useCurrentLocation(viaAuto) {
  // Stuck-busy guard: if a previous run crashed past its finally (or an old
  // cached script left the flag set), a timestamp older than the ~40s locator
  // ceiling means "stale", not "in progress" — reset so the button works.
  if (gpsLocateBusy && (Date.now() - gpsLocateStartedAt) > 45000) {
    try { if (typeof gpsLog === 'function') gpsLog('stale busy flag reset (>45s) — previous run never finished', 'dbg-warn'); } catch (e) {}
    gpsLocateBusy = false;
    gpsLocateStartedAt = 0;
  }
  hideLocError();
  hidePermissionHelp();
  setRetryVisible(false);
  // One locator at a time — but never silently drop a MANUAL tap that
  // arrives while the quiet gate-open auto attempt is still running:
  // remember it and let the finishing auto attempt rerun it as a manual
  // one (see the handoff in handleGPSFailure/applyGPSFix).
  if (gpsLocateBusy) {
    if (!viaAuto) {
      gpsRerunManual = true;
      // Tell them the tap landed — a silent no-op feels exactly like a dead
      // button. The queued manual attempt runs when the auto one finishes.
      setLocateBar(null, 'Noted — starting your location request right after this one…');
      try { if (typeof gpsLog === 'function') gpsLog('MANUAL tap queued (auto in progress) — will rerun as real attempt', 'dbg-warn'); } catch (e) {}
    }
    return;
  }

  // On the automatic attempt keep a restored/saved pin — don't wipe what the
  // returning customer already has while GPS takes its shot. Manual requests
  // always start clean so a stale pin can't be confirmed by accident.
  if (!viaAuto) {
    pendingCoords = null;
    pinSource = null;
  }

  if (!LocationService.isGeolocationSupported()) {
    locationPermissionState = 'unavailable';
    setLocateBar('error', "📍 Location isn't supported here — tap your spot on the map below");
    focusMap();
    return;
  }

  // ANDROID WEBVIEW FAST-PATH: inside Messenger-on-Android (or any Android
  // webview) the geolocation object exists but NEVER answers. Probing takes
  // 2.5s; the full GPS run would burn ~33s then time out. On a dead probe,
  // skip straight to the map + Chrome escape hatch.
  // iPhones are unaffected (WKWebView answers properly → probe passes fast).
  try {
    if (isAndroidWebView()) {
      gpsLocateBusy = true;
      gpsLocateStartedAt = Date.now();
      setGPSButtonState('locating');
      setLocateBar(null, 'Checking location support…');
      const alive = await probeGpsProvider();
      gpsLocateBusy = false;
      gpsLocateStartedAt = 0;
      if (!alive) {
        try { if (typeof gpsLog === 'function') gpsLog('Android webview probe: provider silent — skipping GPS run', 'dbg-warn'); } catch (e) {}
        setGPSButtonState('idle');
        setLocateBar('error', "📍 GPS is blocked in this in-app browser — tap 'Share my location in chat' below, or drop your pin on the map");
        setRetryVisible(false);
        showOpenInBrowserHelp();
        focusMap();
        return;
      }
      try { if (typeof gpsLog === 'function') gpsLog('Android webview probe: provider alive — running full GPS', 'dbg-ok'); } catch (e) {}
      // Fall through to the normal run below (fresh flags).
    }
  } catch (e) { gpsLocateBusy = false; gpsLocateStartedAt = 0; }

  gpsLocateBusy = true;
  gpsLocateStartedAt = Date.now();
  setGPSButtonState('locating');
  setLocateBar(null, viaAuto ? 'Finding your location…' : 'Getting your location…');
  gpsElapsedStart(!!viaAuto);
  // TEMP debug trace (remove with gpsLog) — full request context.
  gpsLog((viaAuto ? 'AUTO' : 'MANUAL') + ' locate start | api=' + (LocationService.isGeolocationSupported() ? 'YES' : 'NO')
    + ' secure=' + (window.isSecureContext ? 'YES' : 'NO')
    + ' proto=' + location.protocol + ' host=' + location.hostname
    + ' perm=' + LocationService.permissionState
    + ' online=' + (navigator.onLine ? 'YES' : 'NO'));

  try {
    // Manual taps force a real GPS attempt (never short-circuit on a stale
    // cached 'denied'); the quiet auto attempt passes nothing so it stays
    // polite when access is blocked.
    const position = await LocationService.getCurrentPosition(viaAuto ? undefined : { force: true });
    if (position && LocationService.isValidLocation(position)) {
      gpsLog('FIX ACQUIRED lat=' + Number(position.lat).toFixed(6) + ' lng=' + Number(position.lng).toFixed(6)
        + ' acc=±' + Math.round(Number(position.accuracy)) + 'm src=' + position.source, 'dbg-ok');
      applyGPSFix(position, viaAuto);
    } else {
      handleGPSFailure({
        code: LocationService.ErrorCodes.POSITION_UNAVAILABLE,
        message: 'Invalid coordinates received',
      }, viaAuto);
    }
  } catch (err) {
    // TEMP debug trace (remove with gpsLog) — full failure context.
    gpsLog('FAILED code=' + ((err && err.code) || '?')
      + ' raw=' + ((err && err._rawCode) || '-') + ' fastFail=' + ((err && err._fastFail) || '-')
      + ' elapsed=' + ((err && err._elapsedMs) || '?') + 'ms'
      + ' | ' + ((err && err.message) || 'no message'), 'dbg-err');
    handleGPSFailure(err, viaAuto);
  } finally {
    gpsElapsedStop();
    gpsLocateBusy = false;
    gpsLocateStartedAt = 0;
    // A manual tap queued behind the gate-open auto run — handoff: the auto
    // result is already shown, now run THEIR attempt with full error surface.
    if (gpsRerunManual) {
      gpsRerunManual = false;
      try { if (typeof gpsLog === 'function') gpsLog('queued manual tap now running', 'dbg-warn'); } catch (e) {}
      setTimeout(() => { try { useCurrentLocation(false); } catch (e) {} }, 250);
    }
  }
}

/** Gate-open auto attempt — kept as a named wrapper for showLocationGate(). */
function autoDetectLocation() {
  useCurrentLocation(true);
}
/** Create the Leaflet map once, after the modal is visible. */
function initLeafletMap() {
  if (locMap) {
    // Re-opened — Leaflet needs a size recalculation.
    setTimeout(() => { if (locMap) locMap.invalidateSize(); }, 150);
    return;
  }
  try {
    const mapEl = $id('loc-map');
    if (!mapEl || typeof L === 'undefined') throw new Error('Leaflet not available');

    // Phone-friendly map: finger drag pans, pinch zooms, single tap drops the
    // pin. tapTolerance widens the tap target for fat fingers; the loading
    // class shows a placeholder until real tiles paint.
    mapEl.classList.add('loc-map-loading');
    locMap = L.map('loc-map', { scrollWheelZoom: false, zoomControl: true, tapTolerance: 22, dragging: true, touchZoom: true })
      .setView([STORE_LOCATION.lat, STORE_LOCATION.lng], 14);
    // Expose globally for console debugging
    window.locMap = locMap;
    window.setMapPin = setMapPin;
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });
    tiles.on('load', () => { try { mapEl.classList.remove('loc-map-loading'); } catch (e) {} });
    tiles.addTo(locMap);
    setTimeout(() => { try { mapEl.classList.remove('loc-map-loading'); } catch (e) {} }, 6000);

    // Tap anywhere to drop/move the pin. A draggable marker + reverse-geocode
    // on dragend lets phone users fine-tune a coarse GPS fix precisely.
    locMap.on('click', (e) => {
      setMapPin({ lat: e.latlng.lat, lng: e.latlng.lng }, false);
    });
    // Re-measure once the container has settled so tiles + pin render correctly
    // even when the sheet was opened from a previously-hidden state.
    setTimeout(() => { if (locMap) locMap.invalidateSize(); }, 80);

    // If GPS (or a map tap) succeeded before the map was ready, fly to the
    // pinned coordinates now that the map exists — so the customer sees their
    // location instead of the store default.
    if (pendingCoords && Number.isFinite(pendingCoords.lat) && Number.isFinite(pendingCoords.lng)) {
      setMapPin(pendingCoords, pinSource === 'gps');
      locMap.flyTo([pendingCoords.lat, pendingCoords.lng], 16, { duration: 0.6 });
    }
  } catch (e) {
    console.warn('[webview] Leaflet init failed, falling back to address-only:', e && e.message);
    locMap = null;
    locMarker = null;
    mapInitFailed = true;
    const wrap = document.querySelector('.loc-map-wrap');
    if (wrap) wrap.style.display = 'none';
    showLocError('Map unavailable — please enter your address manually below.');
  }
}

/** Hide the location modal and restore page scrolling. */
function hideLocationGate() {
  const gate = $id('location-gate');
  if (gate) gate.classList.add('hidden');
  forceHeaderVisible(); // header returns after choosing/changing a location
  const mainContent = $id('main-content');
  if (mainContent) mainContent.classList.remove('hidden');
  document.body.style.overflow = '';
}

function showLocError(msg) {
  const el = $id('loc-gate-error');
  if (el) {
    el.textContent = msg;
    el.classList.remove('hidden');
  }
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
// Named address resolved for the chosen point — from reverse-geocoding the
// GPS fix / map pin, a search-result pick, or the gate prefill. The old
// editable "Complete address" textarea was removed: the pin, the search and
// the landmark carry the information now, so this lives in state instead.
let pendingAddress = null;
// True once the customer explicitly picked an address (search result) —
// later auto-geocoding never overwrites an explicit choice.
let pendingAddressFromUser = false;

/** Store/show the resolved address. fromUser=true marks an explicit customer
 *  choice (search pick) that subsequent auto-geocoding must not stomp. */
function setPendingAddress(addr, fromUser) {
  const text = (addr && String(addr).trim()) || null;
  if (fromUser) {
    pendingAddressFromUser = true;
    pendingAddress = text;
  } else if (!pendingAddressFromUser) {
    pendingAddress = text;
  }
  const view = $id('loc-resolved');
  if (view) {
    if (pendingAddress) {
      view.textContent = '📍 ' + pendingAddress;
      view.classList.remove('hidden');
    } else {
      view.classList.add('hidden');
    }
  }
  updateLocConfirmState();
}

/** Drop/move the pin and remember the chosen point. */
/** Smoothly zoom the map into the pinned coordinates. Works around the two
 *  classic Leaflet-in-modal pitfalls: (1) the container hasn't settled when
 *  the modal just opened (setView silently no-ops) — invalidateSize first and
 *  fly on the next frame; (2) the map may not exist yet at all (GPS won the
 *  race against Leaflet loading) — pin when it becomes available. */
function zoomMapToPin(coords, zoom, smooth, fromGps) {
  if (!coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) return;
  if (!mapAvailable() || !locMap) {
    // Map not ready yet (e.g. GPS won the race against Leaflet loading) —
    // keep the coords pending; the gate already covers the no-map fallback.
    pendingCoords = { lat: coords.lat, lng: coords.lng };
    pinSource = fromGps ? 'gps' : 'pin';
    updateLocConfirmState();
    return;
  }
  setMapPin(coords, !!fromGps);
  // Next frame(s): invalidateSize so the container is measured, then fly/set.
  const doFly = () => {
    if (!locMap) return;
    try {
      locMap.invalidateSize();
      const target = [coords.lat, coords.lng];
      if (smooth && typeof locMap.flyTo === 'function') locMap.flyTo(target, zoom, { duration: 0.6 });
      else locMap.setView(target, zoom);
    } catch (e) {
      console.warn('[webview] map zoom failed:', e && e.message);
      try { locMap.setView([coords.lat, coords.lng], zoom); } catch { /* ignore */ }
    }
  };
  requestAnimationFrame(() => setTimeout(doFly, 60));
}

function setMapPin(latlng, fromGps) {
  pendingCoords = { lat: latlng.lat, lng: latlng.lng };
  pinSource = fromGps ? 'gps' : 'pin';
  if (mapAvailable()) {
    if (!locMarker) {
      locMarker = L.marker([latlng.lat, latlng.lng], {
        draggable: true,
        icon: L.divIcon({ className: 'loc-pin', html: '📍', iconSize: [32, 32], iconAnchor: [16, 30] }),
      }).addTo(locMap);
      // Dragging fine-tunes the point (same handling as a fresh tap).
      locMarker.on('dragend', () => {
        const p = locMarker.getLatLng();
        setMapPin({ lat: p.lat, lng: p.lng }, false);
      });
    } else {
      locMarker.setLatLng([latlng.lat, latlng.lng]);
    }
  }
  hideLocError();
  updateLocConfirmState();
  if (!fromGps) {
    // Name the picked point so the address box pre-fills — only when empty,
    // never stomping on what the customer already typed. Race against a timeout
    // so a hung Geocoder can't trap the customer.
    Promise.race([
      reverseGeocode(latlng.lat, latlng.lng),
      new Promise((_, reject) => setTimeout(() => reject(new Error('geocode-timeout')), 5000)),
    ])
      .then((addr) => {
        setPendingAddress(addr);
      })
      .catch(() => { /* offline / rate-limited/timeout — the pin still carries the spot */ });
  }
}

/** Server-side saved location for this session — set by a chat link share
 *  (a Google Maps / Waze link pasted in chat, parsed by the bot webhook) or by
 *  an earlier gate confirm. This is the ONLY GPS fix that reliably works
 *  inside Messenger's Android webview, so the gate prefills it when it exists. */
let chatLocationLoaded = false;
async function loadChatLocationIntoGate(saved) {
  if (chatLocationLoaded) return;
  chatLocationLoaded = true;
  try {
    const loc = await api('/location?session=' + encodeURIComponent(sessionId));
    if (!loc) return;
    const lat = Number(loc.lat);
    const lng = Number(loc.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return;
    // A location confirmed locally this session wins over the server copy.
    if (saved && Number.isFinite(Number(saved.lat)) && Number.isFinite(Number(saved.lng))) return;
    pendingCoords = { lat, lng };
    pinSource = 'pin';
    setMapPin({ lat, lng }, false);
    if (loc.address && !pendingAddress) setPendingAddress(loc.address);
    try { if (locMap && typeof locMap.flyTo === 'function') locMap.flyTo([lat, lng], 16, { duration: 0.6 }); } catch (e) {}
    setCoordsDisplay(lat, lng);
    updateLocConfirmState();
    showToast('📍 Loaded your saved location — check the pin and confirm');
    try { if (typeof gpsLog === 'function') gpsLog('server location prefilled lat=' + lat + ' lng=' + lng, 'dbg-ok'); } catch (e) {}
  } catch (e) { /* no record / offline — the gate stays fully usable */ }
}

/** "Share my location in chat" — the in-Messenger GPS path that still works:
 *  Meta removed native location sharing to Pages, but a Google Maps / Waze
 *  LINK can still be shared in chat — the bot parses the coordinates from the
 *  link, saves them server-side, and the next gate open prefills the pin. */
function useChatLocation() {
  try {
    const help = $id('loc-chat-help');
    if (help) help.classList.remove('hidden');
    setLocateBar('neutral', 'Paste a Google Maps / Waze link in the chat below, then reopen the store');
    try { if (typeof gpsLog === 'function') gpsLog('chat-locate: link-share instructions shown', 'dbg-warn'); } catch (e) {}
    // Drop them back into the conversation where they can paste the map link.
    const ext = window.MessengerExtensions;
    if (ext && typeof ext.requestCloseBrowser === 'function') {
      try {
        ext.requestCloseBrowser(
          () => console.log('[webview] closed to chat for location link share'),
          () => {}
        );
      } catch (e) {}
    } else {
      try { window.close(); } catch (e) {}
    }
  } catch (e) {}
}

/** Re-fetch the server location after the customer says they sent it. */
async function reloadChatLocation() {
  try {
    chatLocationLoaded = false;
    await loadChatLocationIntoGate(getSavedLocation());
    const help = $id('loc-chat-help');
    if (help) help.classList.add('hidden');
  } catch (e) {}
}

/** Pan the map to the store and nudge the customer to tap their spot. */
function focusMap() {
  if (mapAvailable()) {
    locMap.setView([STORE_LOCATION.lat, STORE_LOCATION.lng], 14);
  }
  // Scroll the map into view inside the sheet so it's obvious what to do next.
  const mapEl = $id('loc-map');
  if (mapEl && mapEl.scrollIntoView) {
    try { mapEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* non-fatal */ }
  }
}

/** Reverse-geocode coordinates into a readable address (OpenStreetMap Nominatim). */
async function reverseGeocode(lat, lng) {
  const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1'
    + '&lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lng);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('reverse geocode HTTP ' + res.status);
  const data = await res.json();
  const a = data.address || {};
  const parts = [
    a.house_number, a.road,
    a.neighbourhood || a.suburb || a.quarter,
    a.barangay || a.village || a.city_district,
    a.city || a.municipality || a.town,
    a.province,
  ].filter(Boolean);
  const text = parts.join(', ');
  if (!text) throw new Error('reverse geocode returned no address');
  return text;
}

/** Forward-geocode an address into coordinate candidates (Nominatim search). */
async function geocodeAddress(query) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=1&q='
    + encodeURIComponent(query);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('search HTTP ' + res.status);
  const data = await res.json();
  return (Array.isArray(data) ? data : []).map((r) => ({
    label: r.display_name || r.name || '',
    lat: Number(r.lat),
    lng: Number(r.lon),
  })).filter((r) => r.lat && r.lng);
}

/** Drop the pin from a search result, name the address, and pan the map. */
function selectSearchResult(result) {
  if (!result || !result.lat || !result.lng) return;
  const coords = { lat: result.lat, lng: result.lng };
  zoomMapToPin(coords, 16, true, false);
  setPendingAddress(result.label, true);
  hideLocError();
}

/** Wire up Nominatim address search on the search input with a custom dropdown.
 *  Debounced keystrokes hit the free Nominatim search API; picking a result
 *  drops the pin, fills the address and pans the map. */
function initSearchAutocomplete() {
  const input = $id('loc-search');
  if (!input) return;
  const wrap = document.querySelector('.loc-search-wrap');
  if (!wrap) return;
  let timer = null;
  let dropdown = null;

  const close = () => { if (dropdown) { dropdown.remove(); dropdown = null; } };

  const render = (results) => {
    close();
    if (!results || !results.length) return;
    dropdown = document.createElement('div');
    dropdown.className = 'loc-search-dropdown';
    results.forEach((r) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'loc-search-item';
      item.textContent = r.label;
      item.addEventListener('click', () => {
        selectSearchResult(r);
        input.value = r.label;
        close();
        input.blur();
      });
      dropdown.appendChild(item);
    });
    // Append to body and position relative to input (fixes overflow clipping)
    document.body.appendChild(dropdown);
    const rect = input.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.top = (rect.bottom + 4) + 'px';
    dropdown.style.left = rect.left + 'px';
    dropdown.style.width = rect.width + 'px';
  };

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (q.length < 3) { close(); return; }
    clearTimeout(timer);
    timer = setTimeout(() => {
      geocodeAddress(q)
        .then(render)
        .catch(() => close());
    }, 350);
  });

  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && (!dropdown || !dropdown.contains(e.target))) close();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}

/** Live guidance under the map: exactly what's still missing before confirming. */
function updateLocConfirmState() {
  const status = $id('loc-status');
  if (!status) return;
  // Coordinate readout under the map — live-synced with pendingCoords so it
  // stays accurate through GPS fixes, map taps and pin drags (and still shows
  // when the map itself failed to load).
  setCoordsDisplay(
    pendingCoords && Number.isFinite(pendingCoords.lat) ? pendingCoords.lat : null,
    pendingCoords && Number.isFinite(pendingCoords.lng) ? pendingCoords.lng : null,
  );
  if (!mapAvailable()) { status.textContent = ''; return; }
  const hasSpot = !!pendingCoords || !!pendingAddress;
  status.classList.toggle('loc-status-ok', hasSpot);
  if (!hasSpot) {
    status.textContent = '📍 Tap the map, search, or use the GPS button above';
  } else if (!pendingAddress) {
    status.textContent = '✓ Spot set — add a landmark below so the rider finds you';
  } else {
    status.textContent = '✓ Location set — ready to confirm!';
  }
}

/** Confirm button — validate and persist the delivery location, then unlock home. */
async function confirmLocation() {
  hideLocError();
  const landmark = (($id('loc-landmark') && $id('loc-landmark').value) || '').trim();
  // Address resolution order: named address (GPS/search/pin) — landmark —
  // coordinate label. With the editable address field gone, the pin, the
  // search and the landmark carry the delivery information.
  const address = pendingAddress
    || (landmark ? 'Near ' + landmark : null)
    || (pendingCoords ? 'Pinned location (' + formatCoords(pendingCoords.lat, pendingCoords.lng) + ')' : null);
  if (!address) {
    showLocError('Set your delivery spot first — use the GPS button, tap the map, search, or type a landmark below.');
    return;
  }
  // FIX: Accept any valid location source (GPS, IP, or map pin). A landmark
  // alone (no pin) is accepted as a manual, coordinate-less location.
  if (pendingCoords && !LocationService.isValidLocation(pendingCoords)) {
    showLocError('Please set your location first \u2014 tap the map or use "Use my current location".', true);
    return;
  }
  
  // If we have coordinates but no source recorded, default to 'pin'
  if (!pinSource) {
    pinSource = 'pin';
  }
  
  // If we have coordinates but permission state wasn't tracked, update it
  if (locationPermissionState === 'unknown' && pinSource === 'gps') {
    locationPermissionState = 'granted';
  }
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
  //   3. Geocoding the address server-side (Nominatim / OpenStreetMap) to
  //      recover coordinates and compute a distance-based fee.
  // For now the location is stored as-is and the checkout delivery line stays
  // "To be decided" until the fee logic is wired up.
  const confirmedLat = pendingCoords ? pendingCoords.lat : null;
  const confirmedLng = pendingCoords ? pendingCoords.lng : null;
  // Persist the confirmed pin server-side so a later gate open (or the bot's
  // chat flow) can reuse it. Fire-and-forget — never blocks the unlock.
  if (Number.isFinite(confirmedLat) && Number.isFinite(confirmedLng)) {
    try {
      api('/location', {
        method: 'PUT',
        body: JSON.stringify({ lat: confirmedLat, lng: confirmedLng, address: address || null }),
      }).catch(() => {});
    } catch (e) {}
  }
  pendingCoords = null;
  pinSource = null;
  pendingAddress = null;
  pendingAddressFromUser = false;
  hideLocationGate();
  updateLocationBar();
  showToast('📍 Location saved!');
  
  // Detect branch AFTER user confirms location
  if (Number.isFinite(confirmedLat) && Number.isFinite(confirmedLng)) {
    // Has coordinates - detect branch from confirmed location
    console.log('[webview] Detecting branch from confirmed coords:', confirmedLat, confirmedLng);
    const branch = await detectBranchFromCoords(confirmedLat, confirmedLng);
    if (branch) {
      showToast('🏬 Showing the ' + (activeBranchName() || branch) + ' menu');
    } else {
      console.warn('[webview] Could not detect branch from coords, showing all');
    }
  } else {
    // No coordinates (manual address) - try IP fallback for approximate branch
    console.log('[webview] No coords, trying IP for approximate branch');
    const ipPosition = await LocationService.getIPBasedLocation();
    if (ipPosition && LocationService.isValidLocation(ipPosition)) {
      const branch = await detectBranchFromCoords(ipPosition.lat, ipPosition.lng);
      if (branch) {
        showToast('🏬 Showing the ' + (activeBranchName() || branch) + ' menu (approximate)');
      }
    }
  }
  
  // Load app data if not already loaded (the startup loaders may have failed
  // — re-attempt so the menu isn't blank), THEN apply the branch filter: the
  // loaders reset products = allProducts, so filtering must come after.
  if (categories.length === 0 && products.length === 0) {
    await loadAppData();
  }
  applyBranchFilter();
  revealMenu();
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
  showLoading('Loading...');

  // Detect Messenger in parallel
  const messengerDetection = detectMessenger();

  // Pre-warm the GPS provider while the catalog loads — by the time the
  // customer taps "Use my current location", the OS already has a fix warm.
  try { warmUpGpsProvider(); } catch (e) {}

  // Check if webview is enabled
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

  // When opened without ?psid (shared URL), resolve the PSID from the Messenger SDK
  if (!psidFromMessenger) {
    const msgrPsid = await resolveMessengerUser();
    if (msgrPsid && msgrPsid !== sessionId) {
      console.log('[webview] PSID resolved from MessengerExtensions');
      sessionId = msgrPsid;
      storageSet('webview_session', sessionId);
    }
  }

  // Show location gate FIRST - load data only AFTER user confirms location
  activeBranch = storageGet('webview_branch_' + sessionId) || null;
  
  console.log('[webview] Init - activeBranch:', activeBranch);
  
  updateLocationBar();
  initHeaderActions();
  initHeaderAutoHide();
  
  // Show the location gate immediately - NO data loading here
  showLocationGate();
  
  isInsideMessenger = await messengerDetection;
  
  console.log('[webview] init complete →', {
    branch: activeBranch,
    sessionId,
    isInsideMessenger,
  });
}

/** Clear all saved locations and branch - for testing */
function clearAllSavedLocations() {
  try {
    storageSet(LOCATION_KEY(), '');
    storageSet(LOCATIONS_KEY(), '[]');
    storageSet('webview_branch_' + sessionId, '');
    activeBranch = null;
    pendingCoords = null;
    pinSource = null;
    console.log('[webview] All saved locations cleared');
    showToast('🗑️ All saved locations cleared');
  } catch (e) {
    console.warn('[webview] Failed to clear locations:', e);
  }
}

// Expose globally for console debugging
window.clearAllSavedLocations = clearAllSavedLocations;

/** Pan map to specific coordinates - for testing */
window.panMapTo = function(lat, lng, zoom) {
  zoom = zoom || 15;
  if (!window.locMap) {
    console.log('Map not loaded yet');
    return;
  }
  console.log('Panning to:', lat, lng);
  window.locMap.setView([lat, lng], zoom);
  if (window.setMapPin) {
    window.setMapPin({ lat: lat, lng: lng }, false);
  }
};

/** Load all app data (products, categories, etc.) - called after location is confirmed */
async function loadAppData() {
  console.log('[webview] Loading app data...');
  showLoading('Loading menu...');
  
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

  // Re-price the restored cart now that products are loaded
  recalcCartTotals();
  storageSet(LOCAL_CART_KEY(), JSON.stringify(cart));
  updateCartBadge();

  // Load branch catalog
  try {
    const bData = await api('/branches');
    if (bData && Array.isArray(bData.branches)) branchCatalog = bData.branches;
  } catch (e) {
    console.warn('[webview] /branches failed — branch filter still works from item data:', e && e.message);
  }
  
  hideLoading();
  
  console.log('[webview] App data loaded:', {
    categories: categories.length,
    products: products.length,
    packages: packages.length,
    foodPacks: foodPacks.length,
    cartItems: cart.items.length,
    orders: orders.length,
  });
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
