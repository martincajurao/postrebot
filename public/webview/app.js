// Session management - when opened from Messenger we receive a ?psid= parameter
// which identifies the customer. Use it as the session so orders link to their account.
const urlParams = new URLSearchParams(window.location.search);
const psidFromMessenger = urlParams.get('psid') || '';

let sessionId = psidFromMessenger || localStorage.getItem('webview_session');
if (!sessionId) {
  sessionId = 'wv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  localStorage.setItem('webview_session', sessionId);
}

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
async function api(path, opts = {}) {
  const res = await fetch('/api/webview' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return res.json();
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2500);
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

// ---- Load data ----
async function loadCategories() {
  categories = await api('/categories');
  renderCategories();
}

async function loadProducts() {
  products = await api('/products');
}

async function loadPackages() {
  packages = await api('/packages');
}

async function loadFoodPacks() {
  foodPacks = await api('/food-packs');
}

async function loadCart() {
  cart = await api('/cart?session=' + sessionId);
  updateCartBadge();
}

async function loadConfig() {
  config = await api('/config');
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
  const cat = categories.find(c => c.id === categoryId);
  document.getElementById('products-title').textContent = cat ? cat.name : 'Products';
  const catProducts = products.filter(p => p.category_id === categoryId);
  const container = document.getElementById('products-list');

  container.innerHTML = catProducts.map(p => {
    const variant = p.variants && p.variants[0];
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

// ---- Product Detail ----
function showProductDetail(productId) {
  const p = products.find(x => x.id === productId);
  if (!p) return;
  selectedVariants[productId] = p.variants && p.variants[0]?.size || null;
  selectedQty = 1;

  const container = document.getElementById('product-detail');
  const img = p.photo_url ? `<img class="detail-image" src="${p.photo_url}" alt="${p.name}">` : '';

  let variantsHtml = '';
  if (p.variants && p.variants.length > 0) {
    variantsHtml = `<div class="variant-options">
      <label>Size:</label>
      ${p.variants.map(v => `<button class="variant-btn ${v.size === selectedVariants[productId] ? 'selected' : ''}" onclick="selectVariant(${productId}, '${v.size}', this)">${v.size} - ${formatMoney(v.price)}</button>`).join('')}
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
    const data = await api('/slots?date=' + date);
    const slotSelect = document.getElementById('time-slot');
    if (!data.open) {
      slotSelect.innerHTML = '<option value="">Date not available</option>';
      return;
    }
    slotSelect.innerHTML = data.slots.map(s =>
      `<option value="${s.label}" ${s.full ? 'disabled' : ''}>${s.label} ${s.full ? '(Full)' : ''}</option>`
    ).join('');
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

  const result = await api('/checkout', {
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
  orders = await api('/orders?session=' + sessionId);
  const container = document.getElementById('orders-list');

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
/** Close the in-Messenger webview and return the user to the chat thread. */
function closeWebview() {
  if (isInsideMessenger && window.MessengerExtensions) {
    try {
      window.MessengerExtensions.requestCloseBrowser(function success() {
        // Webview closed successfully
      }, function error(err) {
        console.error('[webview] requestCloseBrowser error:', err);
      });
    } catch (e) {
      console.error('[webview] MessengerExtensions error:', e);
    }
  }
}

// ---- Init ----
async function init() {
  // Detect if we're running inside Messenger's webview
  if (window.MessengerExtensions) {
    try {
      window.MessengerExtensions.getSupportedFeatures(function (result) {
        isInsideMessenger = true;
      }, function () {
        isInsideMessenger = false;
      });
    } catch (e) {
      isInsideMessenger = false;
    }
  }

  // Check if webview is enabled
  const enabledData = await api('/enabled');
  if (!enabledData.enabled) {
    document.getElementById('loading-view').classList.remove('active');
    document.getElementById('disabled-msg').classList.remove('hidden');
    document.getElementById('main-content').classList.add('hidden');
    document.getElementById('bottom-nav').style.display = 'none';
    return;
  }

  await Promise.all([loadCategories(), loadProducts(), loadPackages(), loadFoodPacks(), loadCart(), loadConfig()]);
  document.getElementById('loading-view').classList.remove('active');
  document.getElementById('main-content').classList.remove('hidden');
  renderCategories();
  showCategories();
}

init();
