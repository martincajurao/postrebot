/* init region */

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

/* END */
