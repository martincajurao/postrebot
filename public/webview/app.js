// ===== Supabase client (optional direct-to-Supabase fallback) =====
const SUPABASE_URL = 'https://npftxbstixrhuiaqpmap.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wZnR4YnN0aXhyaHVpYXFwbWFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4MTQwMDQsImV4cCI6MjEwMzM5MDAwNH0.9NFykxXdzeVfNRd4KikObsCmNsW2Ex3mFjftMLuWxMU';

// The Supabase JS CDN can be blocked or load slowly (e.g. inside Messenger's webview).
// Never let a missing CDN script kill the whole app — create the client lazily and only
// use it as a fallback when the REST API (/api/webview) is unreachable.
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

// Session management - when opened from Messenger we receive a ?psid= parameter
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

// State
let categories = [];
let products = [];
let packages = [];
let foodPacks = [];
let cart = { items: [], totals: { subtotal: 0, delivery: 0, total: 0 } };
let currentView = 'categories';
let currentCategory = null;
let selectedVariants = {};
let selectedQuantities = {};
let packageSelections = {};
let selectedQty = 1;
let orders = [];
let config = { payment: {}, contact: {} };
let messengerLink = '';
let isInsideMessenger = false;

// ---- Helpers ----
/** Fetch the REST endpoint. Throws on any failure so callers can fall back. */
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

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2500);
}

// #loading-view has an inline display:flex that beats the .view{display:none} rule,
// so toggling the 'active' class alone never hides the spinner. Set the inline
// display explicitly instead.
function showLoading(msg) {
  const el = document.getElementById('loading-view');
  if (!el) return;
  const txt = document.getElementById('loading-text');
  if (txt && msg) txt.textContent = msg;
  el.classList.add('active');
  el.style.display = 'flex';
}
function hideLoading() {
  const el = document.getElementById('loading-view');
  if (!el) return;
  const txt = document.getElementById('loading-text');
  if (txt) txt.textContent = 'Loading...';
  el.classList.remove('active');
  el.style.display = 'none';
}

function formatMoney(n) {
  return '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  currentView = id.replace('view-', '');
  // Update bottom nav active state
  updateBottomNav();
}

function updateBottomNav() {
  const navMap = {
    'categories': 0,
    'products': 0,
    'food-packs': 1,
    'cart': 2,
    'orders': 3,
    'checkout': 2,
  };
  const idx = navMap[currentView];
  if (idx === undefined) return;
  document.querySelectorAll('.nav-btn').forEach((btn, i) => {
    btn.classList.toggle('active', i === idx);
  });
}

function goBack() {
  if (currentView === 'product-detail' || currentView === 'package') {
    showProducts(currentCategory);
  } else {
    showCategories();
  }
}

function updateCartBadge() {
  const badge = document.getElementById('cart-badge');
  const count = cart.items.reduce((s, i) => s + i.quantity, 0);
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ---- Load data (REST API first, direct Supabase as a fallback) ----
async function loadCategories() {
  try {
    const data = await api('/categories');
    categories = Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[webview] /categories via API failed:', e && e.message);
    const client = getSupabaseClient();
    if (client) {
      try {
        const { data } = await client.from('categories').select('*').eq('active', 1).order('sort_order');
        categories = data || [];
      } catch { categories = []; }
    } else {
      categories = [];
    }
  }
  console.log('[webview] data → categories:', categories.length, categories.map(c => ({ id: c.id, name: c.name })));
  renderCategories();
}

async function loadProducts() {
  try {
    const data = await api('/products');
    products = Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[webview] /products via API failed:', e && e.message);
    const client = getSupabaseClient();
    if (!client) { products = []; return; }
    try {
      const { data } = await client.from('products').select('*, product_variants(*)').eq('active', 1).order('category_id, sort_order');
      products = data || [];
    } catch { products = []; }
  }
  console.log('[webview] data → products:', products.length, products[0]
    ? { id: products[0].id, name: products[0].name, category_id: products[0].category_id, category_id_type: typeof products[0].category_id, variants: (products[0].product_variants || []).length }
    : null);
}

async function loadPackages() {
  try {
    const data = await api('/packages');
    packages = Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[webview] /packages via API failed:', e && e.message);
    const client = getSupabaseClient();
    if (!client) { packages = []; return; }
    try {
      const { data } = await client.from('packages')
        .select('*, package_slots:package_slots(*, package_options:package_options(*))')
        .eq('active', 1)
        .order('id');
      packages = (data || []).map(pkg => ({
        ...pkg,
        slots: (pkg.package_slots || []).map(slot => ({
          ...slot,
          options: slot.package_options || [],
        })),
      }));
    } catch { packages = []; }
  }
  console.log('[webview] data → packages:', packages.length, packages[0] ? { id: packages[0].id, name: packages[0].name, slots: packages[0].slots ? packages[0].slots.length : 0 } : null);
}

async function loadFoodPacks() {
  try {
    const data = await api('/food-packs');
    foodPacks = Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[webview] /food-packs via API failed:', e && e.message);
    const client = getSupabaseClient();
    if (!client) { foodPacks = []; return; }
    try {
      const { data } = await client.from('food_packs').select('*').eq('active', 1).order('sort_order');
      foodPacks = data || [];
    } catch { foodPacks = []; }
  }
  console.log('[webview] data → foodPacks:', foodPacks.length, foodPacks.map(fp => ({ id: fp.id, name: fp.name, price: fp.price })));
}

async function loadCart() {
  try {
    const data = await api('/cart?session=' + sessionId);
    cart = {
      items: (data && data.items) || [],
      totals: (data && data.totals) || { subtotal: 0, delivery: 0, total: 0 },
    };
  } catch (e) {
    console.warn('[webview] /cart failed:', e && e.message);
    cart = { items: [], totals: { subtotal: 0, delivery: 0, total: 0 } };
  }
  console.log('[webview] data → cart items:', cart.items.length, cart.totals);
  updateCartBadge();
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
  console.log('[webview] data → config:', config);
  messengerLink = 'https://m.me/postrefoodproducts';
  const link = document.getElementById('messenger-link-disabled');
  if (link) link.href = messengerLink;
}

// ---- Render Categories ----
function renderCategories() {
  const container = document.getElementById('categories-list');
  const icons = { 'pasta': '\u{1F35D}', 'rice': '\u{1F35A}', 'dessert': '\u{1F370}', 'drinks': '\u{1F9C3}', 'appetizer': '\u{1F363}', 'soup': '\u{1F372}' };

  container.innerHTML = categories.map(c => {
    const icon = icons[c.name?.toLowerCase()] || '\u{1F374}';
    return `<div class="category-card" onclick="showProducts(${c.id})">
      <div class="icon">${icon}</div>
      <div class="name">${c.name}</div>
    </div>`;
  }).join('');
}

// ---- Render Products ----
function showProducts(categoryId) {
  currentCategory = categoryId;
  categoryId = Number(categoryId);
  const cat = categories.find(c => Number(c.id) === categoryId);
  document.getElementById('products-title').textContent = cat ? cat.name : 'Products';
  const catProducts = products.filter(p => Number(p.category_id) === categoryId);
  console.log(
    '[webview] showProducts(category=' + categoryId + ' "' + (cat ? cat.name : '?') + '") → ' +
    catProducts.length + ' of ' + products.length + ' products matched'
  );
  if (catProducts.length === 0) {
    console.log('[webview] no-match diagnostics:', {
      requestedCategory: categoryId,
      totalProducts: products.length,
      productCategoryIdsInState: [...new Set(products.map(p => p.category_id))],
      categoriesInState: categories.map(c => ({ id: c.id, name: c.name })),
    });
  }
  const container = document.getElementById('products-list');

  if (catProducts.length === 0) {
    if (products.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="icon">🍽️</div><p>Couldn't load the items. Check your connection and try again.</p></div>
        <button class="btn btn-primary" style="width:100%" onclick="retryProducts(${categoryId})">Retry</button>`;
    } else {
      container.innerHTML = '<div class="empty-state"><div class="icon">🍽️</div><p>No items in this category yet.</p></div>';
    }
    showView('view-products');
    return;
  }

  container.innerHTML = catProducts.map(p => {
    const variants = p.product_variants || [];
    const variant = variants[0];
    const price = variant ? formatMoney(variant.price) : '';
    const img = p.photo_url ? `<img src="${p.photo_url}" alt="${p.name}">` : `<img src="" alt="">`;
    return `<div class="product-card" onclick="showProductDetail(${p.id})">
      ${img}
      <div class="info">
        <div class="name">${p.name}</div>
        <div class="price">${price}</div>
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

// ---- Product Detail ----
function showProductDetail(productId) {
  const p = products.find(x => x.id === productId);
  if (!p) return;
  const variants = p.product_variants || [];
  selectedVariants[productId] = variants[0]?.size || null;
  selectedQty = 1;

  const container = document.getElementById('product-detail');
  const img = p.photo_url ? `<img class="detail-image" src="${p.photo_url}" alt="${p.name}">` : '';

  let variantsHtml = '';
  if (variants.length > 0) {
    variantsHtml = `<div class="variant-options">
      <label>Size:</label>
      ${variants.map(v => `<button class="variant-btn ${v.size === selectedVariants[productId] ? 'selected' : ''}" onclick="selectVariant(${productId}, '${v.size}', this)">${v.size} - ${formatMoney(v.price)}</button>`).join('')}
    </div>`;
  }

  container.innerHTML = `
    ${img}
    <div class="detail-name">${p.name}</div>
    <div class="detail-desc">${p.description || ''}</div>
    ${variantsHtml}
    <div class="qty-selector">
      <button class="qty-btn" onclick="changeQty(-1)">−</button>
      <span class="qty-value" id="qty-value">${selectedQty}</span>
      <button class="qty-btn" onclick="changeQty(1)">+</button>
    </div>
    <button class="btn btn-primary btn-checkout" onclick="addToCartProduct(${productId})">Add to Cart</button>
  `;
  showView('view-product-detail');
}

function selectVariant(productId, size, btn) {
  selectedVariants[productId] = size;
  btn.parentElement.querySelectorAll('.variant-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
}

function changeQty(delta) {
  selectedQty = Math.max(1, selectedQty + delta);
  document.getElementById('qty-value').textContent = selectedQty;
}

async function addToCartProduct(productId) {
  const size = selectedVariants[productId];
  await api('/cart/add', {
    method: 'POST',
    body: JSON.stringify({
      session: sessionId,
      product_id: productId,
      variant_size: size,
      quantity: selectedQty,
    }),
  });
  await loadCart();
  showToast('Added to cart!');
}

// ---- Packages ----
function showPackageDetail(pkgId) {
  const pkg = packages.find(x => x.id === pkgId);
  if (!pkg) return;
  packageSelections[pkgId] = {};
  selectedQty = 1;

  const container = document.getElementById('package-detail');
  const img = pkg.photo_url ? `<img class="detail-image" src="${pkg.photo_url}" alt="${pkg.name}">` : '';

  let slotsHtml = '';
  if (pkg.slots) {
    slotsHtml = pkg.slots.map(slot => {
      const defaultOpt = slot.options && slot.options.find(o => o.is_default) || slot.options?.[0];
      if (defaultOpt) packageSelections[pkgId][slot.slot_number] = defaultOpt.product_id;
      return `<div class="package-slot">
        <h4>${slot.name || 'Slot ' + slot.slot_number}</h4>
        <div class="slot-options">
          ${(slot.options || []).map(opt => `<span class="slot-option ${opt.product_id === defaultOpt?.product_id ? 'selected' : ''}" onclick="selectPackageSlot(${pkgId}, ${slot.slot_number}, ${opt.product_id}, this)">${opt.name}</span>`).join('')}
        </div>
      </div>`;
    }).join('');
  }

  container.innerHTML = `
    ${img}
    <div class="detail-name">${pkg.name}</div>
    <div class="detail-desc">${pkg.description || ''}</div>
    <div class="detail-desc">Base price: ${formatMoney(pkg.base_price)}</div>
    ${slotsHtml}
    <div class="qty-selector">
      <button class="qty-btn" onclick="changeQty(-1)">−</button>
      <span class="qty-value" id="qty-value">${selectedQty}</span>
      <button class="qty-btn" onclick="changeQty(1)">+</button>
    </div>
    <button class="btn btn-primary btn-checkout" onclick="addToCartPackage(${pkgId})">Add to Cart</button>
  `;
  showView('view-package');
}

function selectPackageSlot(pkgId, slotNum, productId, el) {
  packageSelections[pkgId][slotNum] = productId;
  el.parentElement.querySelectorAll('.slot-option').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
}

async function addToCartPackage(pkgId) {
  const selections = packageSelections[pkgId] || {};
  const slotChoices = Object.entries(selections).map(([slot, product_id]) => ({
    slot_number: Number(slot),
    product_id,
  }));
  await api('/cart/add', {
    method: 'POST',
    body: JSON.stringify({
      session: sessionId,
      package_id: pkgId,
      quantity: selectedQty,
      slot_choices: slotChoices,
    }),
  });
  await loadCart();
  showToast('Added to cart!');
}

// ---- Food Packs ----
function showFoodPacks() {
  const container = document.getElementById('food-packs-list');
  console.log('[webview] showFoodPacks → foodPacks in state:', foodPacks.length, foodPacks.map(fp => ({ id: fp.id, name: fp.name, price: fp.price, active: fp.active })));

  if (foodPacks.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="icon">🍱</div><p>Couldn't load food packs. Check your connection and try again.</p></div>
      <button class="btn btn-primary" style="width:100%" onclick="retryFoodPacks()">Retry</button>`;
    showView('view-food-packs');
    return;
  }

  container.innerHTML = foodPacks.map(fp => {
    const img = fp.photo_url ? `<img src="${fp.photo_url}" alt="${fp.name}">` : `<img src="" alt="">`;
    return `<div class="product-card" onclick="addToCartFoodPack(${fp.id})">
      ${img}
      <div class="info">
        <div class="name">${fp.name}</div>
        <div class="price">${formatMoney(fp.price)}</div>
      </div>
    </div>`;
  }).join('');
  showView('view-food-packs');
}

async function retryFoodPacks() {
  showLoading('Loading food packs…');
  await loadFoodPacks();
  hideLoading();
  showFoodPacks();
}

async function addToCartFoodPack(fpId) {
  await api('/cart/add', {
    method: 'POST',
    body: JSON.stringify({ session: sessionId, food_pack_id: fpId, quantity: 1 }),
  });
  await loadCart();
  showToast('Added to cart!');
}

// ---- Cart ----
function showCart() {
  const container = document.getElementById('cart-items');
  if (cart.items.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="icon">\u{1F6D2}</div><p>Your cart is empty</p></div>';
  } else {
    container.innerHTML = cart.items.map(item => `
      <div class="cart-item">
        <div class="item-info">
          <div class="item-name">${item.name}</div>
          <div class="item-price">Qty: ${item.quantity}</div>
        </div>
        <div class="qty-controls">
          <button onclick="updateCartItem(${item.id}, ${item.quantity - 1})">-</button>
          <button onclick="updateCartItem(${item.id}, ${item.quantity + 1})">+</button>
        </div>
        <button class="remove-btn" onclick="removeCartItem(${item.id})">\u{1F5D1}</button>
      </div>
    `).join('');
  }
  const totals = document.getElementById('cart-totals');
  totals.innerHTML = `
    <div class="total-row"><span>Subtotal</span><span>${formatMoney(cart.totals.subtotal)}</span></div>
    <div class="total-row"><span>Delivery</span><span>${formatMoney(cart.totals.delivery)}</span></div>
    <div class="total-row grand"><span>Total</span><span class="value">${formatMoney(cart.totals.total)}</span></div>
  `;
  showView('view-cart');
}

async function updateCartItem(itemId, qty) {
  await api('/cart/update-quantity', {
    method: 'POST',
    body: JSON.stringify({ session: sessionId, item_id: itemId, quantity: qty }),
  });
  await loadCart();
  showCart();
}

async function removeCartItem(itemId) {
  await api('/cart/remove', {
    method: 'POST',
    body: JSON.stringify({ session: sessionId, item_id: itemId }),
  });
  await loadCart();
  showCart();
}

// ---- Checkout ----
function startCheckout() {
  if (cart.items.length === 0) return showToast('Cart is empty');
  const container = document.getElementById('checkout-form');
  container.innerHTML = `
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
      <div class="payment-option selected" onclick="selectPayment('cod', this)">
        <input type="radio" name="payment" value="cod" checked> Cash on Delivery
      </div>
      <div class="payment-option" onclick="selectPayment('gcash', this)">
        <input type="radio" name="payment" value="gcash"> GCash
      </div>
      <div class="payment-option" onclick="selectPayment('bank', this)">
        <input type="radio" name="payment" value="bank"> Bank Transfer
      </div>
    </div>
    <div id="payment-info" class="detail-desc"></div>
    <button class="btn btn-primary btn-checkout" onclick="placeOrder()">Place Order</button>
  `;

  document.getElementById('order-type').addEventListener('change', function () {
    document.getElementById('address-group').style.display = this.value === 'delivery' ? 'block' : 'none';
  });

  document.getElementById('fulfill-date').addEventListener('change', async function () {
    const date = this.value;
    if (!date) return;
    const slotSelect = document.getElementById('time-slot');
    showLoading('Loading time slots…');
    try {
      const data = await api('/slots?date=' + date);
      if (!data.open) {
        slotSelect.innerHTML = '<option value="">Date not available</option>';
        return;
      }
      slotSelect.innerHTML = data.slots.map(s =>
        `<option value="${s.label}" ${s.full ? 'disabled' : ''}>${s.label} ${s.full ? '(Full)' : ''}</option>`
      ).join('');
    } catch (e) {
      console.warn('[webview] /slots failed:', e && e.message);
      slotSelect.innerHTML = '<option value="">Could not load time slots</option>';
      showToast('Could not load time slots — check your connection');
    } finally {
      hideLoading();
    }
  });

  const today = new Date().toISOString().split('T')[0];
  document.getElementById('fulfill-date').setAttribute('min', today);
  showView('view-checkout');
}

function selectPayment(method, el) {
  document.querySelectorAll('.payment-option').forEach(p => p.classList.remove('selected'));
  el.classList.add('selected');
  el.querySelector('input').checked = true;
  const info = config.payment[method] || '';
  document.getElementById('payment-info').textContent = info;
}

async function placeOrder() {
  const orderType = document.getElementById('order-type').value;
  const address = document.getElementById('address').value;
  const phone = document.getElementById('phone').value;
  const fulfillDate = document.getElementById('fulfill-date').value;
  const timeSlot = document.getElementById('time-slot').value;
  const paymentMethod = document.querySelector('input[name="payment"]:checked')?.value;

  if (!phone) return showToast('Please enter contact number');
  if (orderType === 'delivery' && !address) return showToast('Please enter delivery address');
  if (!fulfillDate) return showToast('Please select fulfillment date');
  if (!timeSlot) return showToast('Please select a time slot');
  if (!paymentMethod) return showToast('Please select payment method');

  showLoading('Placing your order…');
  let result;
  try {
    result = await api('/checkout', {
      method: 'POST',
      body: JSON.stringify({
        session: sessionId,
        order_type: orderType,
        address,
        phone,
        fulfillment_date: fulfillDate,
        time_slot: timeSlot,
        payment_method: paymentMethod,
      }),
    });
  } catch (e) {
    hideLoading();
    showToast((e && e.message) || 'Failed to place order');
    return;
  }
  hideLoading();

  if (result.ok) {
    await loadCart();
    // Show success screen
    document.getElementById('success-order-number').textContent = 'Order #' + result.order_number;
    showView('view-success');
    // Auto-close webview after delay when inside Messenger
    if (isInsideMessenger) {
      setTimeout(() => closeWebview(), 3000);
    }
  } else {
    showToast(result.error || 'Failed to place order');
  }
}

// ---- Orders ----
async function showOrders() {
  const container = document.getElementById('orders-list');
  showLoading('Loading your orders…');
  try {
    orders = await api('/orders?session=' + sessionId);
    if (!Array.isArray(orders)) orders = [];
  } catch (e) {
    console.warn('[webview] /orders failed:', e && e.message);
    orders = [];
    showToast('Could not load orders — check your connection');
  } finally {
    hideLoading();
  }

  if (orders.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="icon">\u{1F4CB}</div><p>No orders yet</p></div>';
  } else {
    container.innerHTML = orders.map(o => `
      <div class="order-card">
        <div class="order-header">
          <span class="order-number">${o.order_number}</span>
          <span class="order-status status-${o.status}">${o.status}</span>
        </div>
        <div>Type: ${o.order_type} | Payment: ${o.payment_method || 'N/A'}</div>
        ${o.fulfillment_date ? `<div>Date: ${o.fulfillment_date} ${o.time_slot || ''}</div>` : ''}
        <div class="order-total">${formatMoney(o.total)}</div>
      </div>
    `).join('');
  }

  showView('view-orders');
}

// ---- Navigation ----
function showCategories() {
  showView('view-categories');
}

// ---- Messenger Extensions integration ----
/**
 * True when the page is rendered inside Messenger's in-app browser.
 * Checked two ways because MessengerExtensions.js availability can race page load:
 *  1. window.MessengerExtensions — set when the SDK loaded (only works in-Messenger)
 *  2. User agent — Messenger's webview UA contains "Messenger" / "FBAV" / "[FB_IAB]"
 */
function detectMessengerUserAgent() {
  const ua = navigator.userAgent || '';
  return /\b(FBAV|FB_IAB|MessengerForiOS|Messenger)\b/i.test(ua) || /\[FB_IAB\]/.test(ua);
}

/** Wait up to ~2s for the MessengerExtensions SDK, then resolve detection. */
async function detectMessenger() {
  if (window.MessengerExtensions) return true;
  // The SDK script is synchronous, but on flaky mobile connections it can land late.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (window.MessengerExtensions) return true;
  }
  return detectMessengerUserAgent();
}

/** Close the in-Messenger webview and return the user to the chat thread. */
function closeWebview() {
  if (window.MessengerExtensions) {
    try {
      window.MessengerExtensions.requestCloseBrowser(function success() {
        // Webview closed successfully
      }, function error(err) {
        console.error('[webview] requestCloseBrowser error:', err);
      });
      return;
    } catch (e) {
      console.error('[webview] MessengerExtensions error:', e);
    }
  }
  // Fallback when opened in a normal browser: try window.close(), else go home.
  window.close();
  setTimeout(() => { if (!window.closed) showCategories(); }, 300);
}

// ---- Init ----
async function init() {
  // Show the spinner for the whole initial fetch.
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

  const mainContent = document.getElementById('main-content');
  const nav = document.getElementById('bottom-nav');

  if (!enabled) {
    hideLoading();
    const disabled = document.getElementById('disabled-msg');
    if (disabled) disabled.classList.remove('hidden');
    if (mainContent) mainContent.classList.add('hidden');
    if (nav) nav.style.display = 'none';
    return;
  }

  // Load everything; settle all results so one failed loader can't blank the whole menu.
  const results = await Promise.allSettled([
    loadCategories(),
    loadProducts(),
    loadPackages(),
    loadFoodPacks(),
    loadCart(),
    loadConfig(),
  ]);
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length > 0) {
    console.warn('[webview] ' + failed.length + ' data loader(s) failed:', failed.map(f => f.reason && f.reason.message));
  }
  console.log('[webview] init complete →', {
    categories: categories.length,
    products: products.length,
    packages: packages.length,
    foodPacks: foodPacks.length,
    cartItems: cart.items.length,
    sessionId,
    isInsideMessenger: await messengerDetection,
  });

  isInsideMessenger = await messengerDetection;

  hideLoading();

  // No catalog data at all → show an actionable error instead of a blank menu.
  if (categories.length === 0) {
    if (mainContent) mainContent.classList.add('hidden');
    const errBox = document.getElementById('load-error');
    if (errBox) errBox.classList.remove('hidden');
    return;
  }

  if (mainContent) mainContent.classList.remove('hidden');
  renderCategories();
  showCategories();
}

function retryLoad() {
  const errBox = document.getElementById('load-error');
  if (errBox) errBox.classList.add('hidden');
  showLoading();
  const mainContent = document.getElementById('main-content');
  if (mainContent) mainContent.classList.add('hidden');
  init();
}

init();
