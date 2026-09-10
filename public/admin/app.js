﻿/* Postre Admin SPA */
const API = '/api/admin';
let TOKEN = localStorage.getItem('token') || '';
let ME = localStorage.getItem('me') || '';
let ME_ID = Number(localStorage.getItem('me_id')) || 0;
let ROLE = localStorage.getItem('role') || 'ADMIN';
let currentView = 'dashboard';

// Messenger webview params (psid/ts/sig, Zxzx bot-signed) — enable "log in once, remembered"
const WV = (() => {
  const q = new URLSearchParams(location.search);
  const psid = q.get('psid'), ts = q.get('ts'), sig = q.get('sig');
  return psid && ts && sig ? { psid, ts, sig } : null;
})();

// ---------- helpers ----------
let loggedOut = false; // Flag to prevent session recovery after explicit logout

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN, ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    // Don't try to recover session if user explicitly logged out
    if (!loggedOut) { recoverSession().catch(() => {}); throw new Error('Session expired'); }
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH');
// ---------- Branches / Locations (availability) ----------
// Mirrors src/services/branches.ts. The active list loads from /api/admin/branches.
let BRANCHES = ['naga', 'calbayog'];
const branchTitle = (b) => (b.length === 1 ? b.toUpperCase() : b.charAt(0).toUpperCase() + b.slice(1));
/** Checkbox group for "available at branches". All-checked === available everywhere. */
function branchChecks(idPrefix, selected = []) {
  if (!BRANCHES.length) return '<p class="muted">No branches configured — add them in Settings → Branches / Locations.</p>';
  const set = new Set((selected || []).map((b) => String(b).toLowerCase()));
  return `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px">
    ${BRANCHES.map((b) => {
      const key = String(b).toLowerCase();
      return `<label style="display:flex;align-items:center;gap:6px;font-size:13px;background:#f6f7f9;border:1px solid #e2e5e8;border-radius:8px;padding:6px 10px;cursor:pointer">
        <input type="checkbox" data-branch data-group="${idPrefix}" value="${esc(key)}" style="width:auto" ${set.size === 0 || set.has(key) ? 'checked' : ''}> ${esc(branchTitle(key))}</label>`;
    }).join('')}
  </div><p class="muted" style="font-size:12px;margin-top:4px">Leave all checked to offer it at every branch — uncheck a branch to hide it there.</p>`;
}
/** Read a branch checkbox group. null = all branches; otherwise the array of branch keys. */
function branchValues(group) {
  const boxes = Array.from(document.querySelectorAll(`[data-branch][data-group="${group}"]`));
  if (!boxes.length) return null;
  const checked = boxes.filter((c) => c.checked).map((c) => c.value);
  return (checked.length === 0 || checked.length === BRANCHES.length) ? null : checked;
}
/** Badges shown in list views: the branches an item IS available at, or "All branches". */
function branchBadges(item) {
  const list = item?.branches || [];
  if (!list.length) return '<span class="muted">All branches</span>';
  return list.map((b) => `<span class="badge b-CONFIRMED">${esc(b)}</span>`).join(' ');
}
function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  document.getElementById('toast').appendChild(t);
  // Auto-dismiss with smooth exit animation
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 200);
  }, 3200);
}
function modal(html) { document.getElementById('modal').innerHTML = html; document.getElementById('modal-overlay').classList.add('show'); }
function closeModal() {
  // Drop any unsaved cropped photos — a pending crop is only valid while its
  // form (modal) is open. Without this a crop from a cancelled form would
  // leak into the next form that reuses the same field id.
  Object.keys(pendingPhotos).forEach(clearPendingPhoto);
  document.getElementById('modal-overlay').classList.remove('show');
}
function showLoading(msg = 'Loading…') {
  modal(`<div style="text-align:center;padding:24px"><div class="spinner" style="border:4px solid #eee;border-top-color:#e74c3c;border-radius:50%;width:36px;height:36px;margin:0 auto 12px;animation:spin .8s linear infinite"></div><p class="muted">${esc(msg)}</p></div><style>@keyframes spin{to{transform:rotate(360deg)}}</style>`);
}
function hideLoading() { closeModal(); }
/**
 * Renders the full menu list a customer ordered (for the reservation details
 * modal). Shows item name, quantity, variant, line total, and any package
 * slot contents. Returns an empty string when there are no items.
 */
/** Format a date like "Sept 8, 2026" from a DB date string. */
function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + (dateStr.length === 10 ? 'T00:00:00' : ''));
  if (isNaN(d.getTime())) return dateStr;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sept','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Format a time slot like "9:00AM" from "10:00" or "10:00:00", rolled back 1 hour for the rider dispatch time. */
function fmtTimeSlot(slot) {
  if (!slot) return '';
  const parts = String(slot).split(':');
  let h = parseInt(parts[0], 10) - 1; // -1h: dispatch/rider ETA is 1h before the customer's slot
  if (h < 0) h = 23; // wrap midnight back to 11 PM
  const m = parts[1] || '00';
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m}${ampm}`;
}

/** Update the PWA app badge with the number of pending orders.
 *  Uses the Badging API (Chrome 81+, Edge 81+, Android 12+). */
function updateAppBadge(count) {
  if (!('setAppBadge' in navigator)) return;
  currentBadgeCount = count;
  if (count > 0) {
    navigator.setAppBadge(count).catch(() => {});
  } else {
    navigator.clearAppBadge().catch(() => {});
  }
}

/** Clear the app badge when admin views the dashboard (acknowledged orders). */
function clearAppBadge() {
  if ('clearAppBadge' in navigator) {
    currentBadgeCount = 0;
    navigator.clearAppBadge().catch(() => {});
  }
}

/** Generate formatted booking details for copy-paste to riders/delivery. */
async function generateBookingDetails(orderId) {
  const order = await api(`/orders/${orderId}`);
  const items = order.items || [];
  const customerName = order.customer_name || 'Customer';
  const customerPhone = order.phone || order.customer_phone || '';

  // Build order lines: package name + slot dishes; plain items just the name.
  const orderLines = [];
  for (const it of items) {
    if (it.package_items && it.package_items.length > 0) {
      orderLines.push(it.name);
      it.package_items
        .sort((a, b) => a.slot_number - b.slot_number)
        .forEach((pkg) => orderLines.push(`-${pkg.product_name}`));
    } else {
      orderLines.push(it.name + (it.quantity > 1 ? ` x${it.quantity}` : ''));
    }
  }

  const df = Number(order.delivery_fee) > 0 ? `₱${Number(order.delivery_fee).toLocaleString()}` : '?';
  const totalStr = `₱${Number(order.total).toLocaleString()}`;
  const dateStr = fmtDate(order.fulfillment_date) + (order.time_slot ? ` (${fmtTimeSlot(order.time_slot)})` : '');

  const pickup = `POSTRE\nZone 5 San Francisco Magarao sa may padjakan pa right side daretso lang pagkababa ng tulay unang kanto katabi ng cream house papasok`;

  const dropoff = `📍Date&Time: ${dateStr}
Name: ${customerName}
Contact#: ${customerPhone}
Order:
${orderLines.join('\n')}
Df ${df}
Total:${totalStr}`;

  const deliveryTo = order.order_type === 'delivery' ? `Delivery to;\n${order.address || 'Pickup'}` : 'Pickup order';

  // Extract the Waze navigation link (appended to the address at order time)
  // so the rider gets a dedicated line + the modal gets an "Open in Waze" button.
  const wazeMatch = String(order.address || '').match(/https?:\/\/[^\s]*waze\.com[^\s]*/);
  const wazeUrl = wazeMatch ? wazeMatch[0] : '';

  return `pick up:\n${pickup}\n\nDrop off;\n${dropoff}\n\n${deliveryTo}${wazeUrl ? `\n\n🗺️ Navigate (Waze): ${wazeUrl}` : ''};;;WAZE=${encodeURIComponent(wazeUrl)}`;
}

function renderOrderItems(orderItems) {
  if (!orderItems || !orderItems.length) return '';
  const lines = orderItems.map((item) => {
    let line = `<div style="padding:8px 0;border-bottom:1px solid #eee"><b>${esc(item.name)}</b> × ${item.quantity}
      ${item.variant_size ? `<span class="muted">(${esc(item.variant_size)})</span>` : ''}
      <span style="float:right;font-weight:700">₱${Number(item.line_total || 0).toLocaleString()}</span>`;
    if (item.package_items && item.package_items.length > 0) {
      line += '<div style="padding-left:16px;font-size:0.85rem;color:#666;margin-top:4px">';
      item.package_items.forEach((pkg) => {
        line += `<div>• Slot ${pkg.slot_number}: ${esc(pkg.product_name)}${pkg.upgrade_price > 0 ? ` (+₱${pkg.upgrade_price})` : ''}</div>`;
      });
      line += '</div>';
    }
    return line + '</div>';
  }).join('');
  const total = orderItems.reduce((sum, it) => sum + Number(it.line_total || 0), 0);
  return `<div style="padding:10px;background:#f8f9fa;border-radius:8px">
    <div style="color:#666;margin-bottom:8px"><b>📝 Menu Ordered (${orderItems.length} item${orderItems.length > 1 ? 's' : ''})</b></div>
    ${lines}
    <div style="padding-top:8px;text-align:right"><b>Total: ₱${total.toLocaleString()}</b></div>
  </div>`;
}

/**
 * Button loader: disables the button, shows a spinner while `fn` runs,
 * then restores it. Prevents double-clicks on slow API calls.
 * Usage: button.addEventListener('click', (e) => withBtn(e.currentTarget, async () => { ... }));
 */
async function withBtn(btn, fn) {
  if (!btn) return fn();
  if (btn.dataset.busy) return; // already running
  btn.dataset.busy = '1';
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add('loading');
  const label = (btn.textContent || '').trim().replace(/^[+→❌✕✅📁📂⬆️➕\s]+/, '') || 'Working';
  btn.innerHTML = `<span class="spin"></span>${esc(label)}`;
  try {
    await fn();
  } catch (err) {
    toast(err.message || String(err), true);
  } finally {
    delete btn.dataset.busy;
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.innerHTML = orig;
  }
}
document.getElementById('modal-overlay').addEventListener('click', (e) => { if (e.target.id === 'modal-overlay') closeModal(); });

// ---------- auth --assad--------
function logout() {
  loggedOut = true; // Prevent session recovery after explicit logout
  TOKEN = ''; ME = ''; ME_ID = 0; ROLE = '';
  localStorage.clear();
  location.hash = '';
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-view').style.display = 'flex';
}

// ---- Messenger webview "remembered login" ----
// Log in once; the server remembers this Messenger account (psid) for 30 days
// (sliding), and every later "admin2020" opens straight into the dashboard.
function webviewSigQS() {
  return WV ? `psid=${encodeURIComponent(WV.psid)}&ts=${encodeURIComponent(WV.ts)}&sig=${encodeURIComponent(WV.sig)}` : '';
}

async function tryRememberedLogin() {
  if (!WV) return false;
  try {
    const res = await fetch(API + '/remembered?' + webviewSigQS());
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({}));
    if (!data.token) return false;
    TOKEN = data.token; ME = data.username || ''; ME_ID = Number(data.id) || 0; ROLE = data.role || 'ADMIN';
    localStorage.setItem('token', TOKEN); localStorage.setItem('me', ME);
    localStorage.setItem('me_id', String(ME_ID)); localStorage.setItem('role', ROLE);
    console.log('[admin] webview remembered login ok');
    return true;
  } catch { return false; }
}

/** 401 recovery: inside the Messenger webview, silently re-login from the
 *  remembered session before falling back to the login page. */
async function recoverSession() {
  TOKEN = '';
  if (await tryRememberedLogin()) {
    loggedOut = false; // Reset flag on successful recovery
    showApp();
    navigate(currentView);
    autoSubscribePush();
    return;
  }
  logout();
}

function showApp() {
  document.getElementById('login-view').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('whoami').textContent = ME + (ROLE === 'ADMIN' ? ' · Admin' : ' · Staff');
  document.querySelectorAll('[data-view="admins"]').forEach((a) => { a.style.display = ROLE === 'ADMIN' ? '' : 'none'; });
  navigate('dashboard');
  // Auto-subscribe to push notifications if permission was already granted
  autoSubscribePush();
  // If permission not yet asked, show a one-time prompt
  if ('Notification' in window && Notification.permission === 'default' && !localStorage.getItem('push_prompt_shown')) {
    localStorage.setItem('push_prompt_shown', '1');
    setTimeout(() => {
      toast('🔔 Enable push notifications for new order alerts! Click here to enable.', false);
      // Make the toast clickable to trigger permission request
      const toastEl = document.querySelector('#toast .toast:last-child');
      if (toastEl) {
        toastEl.style.cursor = 'pointer';
        toastEl.addEventListener('click', async () => {
          try {
            await subscribePush();
            toast('✅ Push notifications enabled! You will now receive order alerts.');
          } catch (e) {
            toast('Could not enable notifications: ' + (e.message || 'permission denied'), true);
          }
        });
      }
    }, 1500);
  }
}
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: document.getElementById('login-user').value, password: document.getElementById('login-pass').value, ...(WV ? { psid: WV.psid, ts: WV.ts, sig: WV.sig } : {}) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    TOKEN = data.token; ME = data.username || document.getElementById('login-user').value;
    ME_ID = Number(data.id) || 0; ROLE = data.role || 'ADMIN';
    localStorage.setItem('token', TOKEN); localStorage.setItem('me', ME);
    localStorage.setItem('me_id', String(ME_ID)); localStorage.setItem('role', ROLE);
    document.getElementById('login-err').textContent = '';
    showApp();
  } catch (err) { document.getElementById('login-err').textContent = err.message; }
});
document.getElementById('logout-btn').addEventListener('click', async () => {
  // In the webview, also drop the server-side remembered session for this psid.
  if (WV) { try { await fetch(API + '/remembered/forget?' + webviewSigQS(), { method: 'POST' }); } catch { /* best effort */ } }
  logout();
});

// ---------- navigation (single source of truth) ----------
const NAV = [
  { view: 'dashboard', icon: '📊', label: 'Dashboard', bottom: 'Home' },
  { view: 'orders', icon: '🛒', label: 'Orders', bottom: 'Orders' },
  { view: 'reservations', icon: '📅', label: 'Reservations', bottom: 'Resv.' },
  { view: 'menu', icon: '🍽️', label: 'Menu', bottom: 'Menu' },
  { view: 'packages', icon: '🔥', label: 'Packages', bottom: 'Pkgs', role: 'ADMIN' },
  { view: 'foodpacks', icon: '🍱', label: 'Food Packs', bottom: 'Packs', role: 'ADMIN' },
  { view: 'customers', icon: '👥', label: 'Customers', bottom: 'Cust.', role: 'ADMIN' },
  { view: 'admins', icon: '🛡️', label: 'Admins', bottom: 'Admins', role: 'ADMIN' },
  { view: 'delivery', icon: '🚚', label: 'Delivery', bottom: 'Deliv.' },
  { view: 'settings', icon: '⚙️', label: 'Settings', bottom: 'Settings' },
  { view: 'images', icon: '🖼️', label: 'Images', bottom: 'Images', role: 'ADMIN' },
];

function buildNav() {
  const items = NAV.filter((n) => !n.role || ROLE === n.role);
  const link = (n, mobile) => {
    const a = document.createElement('a');
    a.href = '#' + n.view;
    a.dataset.view = n.view;
    a.innerHTML = mobile ? `<span>${n.icon}</span>${n.bottom}` : `${n.icon} ${n.label}`;
    return a;
  };
  const side = document.getElementById('side-nav');
  const bottom = document.getElementById('bottom-nav');
  side.innerHTML = ''; bottom.innerHTML = '';
  items.forEach((n) => { side.appendChild(link(n, false)); bottom.appendChild(link(n, true)); });
}

function applyHash() {
  const allowed = NAV.filter((n) => !n.role || ROLE === n.role).map((n) => n.view);
  const requested = (location.hash || '').replace(/^#/, '');
  const view = allowed.includes(requested) ? requested : allowed[0];
  navigate(view);
}

function navigate(view) {
  currentView = view;
  if (location.hash !== '#' + view) { location.hash = view; return; } // re-enters via applyHash
  document.querySelectorAll('[data-view]').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  // keep the scrolled-to tab visible on mobile
  const active = document.querySelector('#bottom-nav a.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center' });
  const main = document.getElementById('main');
  main.innerHTML = '<p class="muted">Loading…</p>';
  views[view](main).catch((err) => { main.innerHTML = ''; toast(err.message, true); });
  window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', applyHash);

function showApp() {
  document.getElementById('login-view').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('whoami').textContent = ME + (ROLE === 'ADMIN' ? ' · Admin' : ' · Staff');
  buildNav();
  applyHash();
}

/* app boot: moved to the very bottom of the file so all views are registered first */
const views = {};

// ---------- image upload helper ----------
const MAX_IMAGE_DIMENSION = 1200;
const JPEG_QUALITY = 0.7;

/**
 * Compress an image file by resizing and converting to JPEG.
 * @param {File} file - Original image file
 * @returns {Promise<File>} Compressed image file
 */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    // Skip compression for small files (< 100KB) or non-image types
    if (file.size < 100 * 1024 || !file.type.startsWith('image/')) {
      resolve(file);
      return;
    }

    // Skip GIFs to preserve animation
    if (file.type === 'image/gif') {
      resolve(file);
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const { width, height } = img;

        // Skip if already small enough
        if (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION) {
          // Still re-encode to JPEG for better compression
          if (file.type === 'image/jpeg' && file.size < 200 * 1024) {
            resolve(file);
            return;
          }
        }

        // Calculate new dimensions
        let newWidth = width;
        let newHeight = height;
        if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
          if (width > height) {
            newWidth = MAX_IMAGE_DIMENSION;
            newHeight = Math.round((height / width) * MAX_IMAGE_DIMENSION);
          } else {
            newHeight = MAX_IMAGE_DIMENSION;
            newWidth = Math.round((width / height) * MAX_IMAGE_DIMENSION);
          }
        }

        // Draw to canvas
        const canvas = document.createElement('canvas');
        canvas.width = newWidth;
        canvas.height = newHeight;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, newWidth, newHeight);
        ctx.drawImage(img, 0, 0, newWidth, newHeight);

        // Convert to blob
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error('Failed to compress image'));
              return;
            }
            const newName = file.name.replace(/\.[^.]+$/, '.jpg');
            const compressedFile = new File([blob], newName, { type: 'image/jpeg' });
            resolve(compressedFile);
          },
          'image/jpeg',
          JPEG_QUALITY
        );
      };
      img.onerror = () => reject(new Error('Failed to load image for compression'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Format file size for display
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function uploadImage(file) {
  // Compress image before upload
  const originalSize = file.size;
  file = await compressImage(file);

  const fd = new FormData();
  fd.append('image', file);
  const res = await fetch(API + '/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd });
  if (res.status === 401) { if (!loggedOut) { recoverSession().catch(() => {}); throw new Error('Session expired'); } return ''; }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data.url;
}
/** Local /uploads files have unique names, so no cache-busting is needed. */
const bustImg = (url) => url || '';
function photoField(id, value) {
  return `
    <div class="field"><label>Photo</label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="file" id="${id}-file" accept="image/*" style="flex:1;min-width:150px">
        <button type="button" class="btn ghost sm" id="${id}-library-btn">📁 From Library</button>
        <img id="${id}-prev" src="${esc(bustImg(value))}" style="height:44px;width:44px;object-fit:cover;border-radius:8px;display:${value ? 'block' : 'none'}">
      </div>
      <input type="hidden" id="${id}" value="${esc(value || '')}">
      <p class="muted" id="${id}-url" style="margin-top:4px;word-break:break-all">${esc(value || 'No photo')}</p>
    </div>`;
}

function restoreModal() {
  const snap = window.__modalSnapshot;
  if (!snap) { closeModal(); return; }
  delete window.__modalSnapshot;
  const m = document.getElementById('modal');
  m.innerHTML = snap.html;
  m.querySelectorAll('input, select, textarea').forEach((el) => {
    if (el.id && snap.values[el.id] !== undefined && el.type !== 'file') el.value = snap.values[el.id];
  });
  if (window.__modalRebind) { const rb = window.__modalRebind; delete window.__modalRebind; rb(); }
}
function openImageLibrary(selectedId) {
  let files = [];
  // snapshot the form currently in the modal (the library replaces it)
  const modalEl = document.getElementById('modal');
  const values = {};
  modalEl.querySelectorAll('input, select, textarea').forEach((el) => { if (el.id) values[el.id] = el.value; });
  window.__modalSnapshot = { html: modalEl.innerHTML, values };
  const content = `
    <div style="max-height:60vh;overflow-y:auto">
      <h3>📁 Select Image</h3>
      <p class="muted" style="margin-bottom:12px">Loading images...</p>
      <div id="library-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px"></div>
    </div>`;
  modal(content);

  const grid = document.getElementById('library-grid');

  async function loadImages() {
    try {
      files = await api('/uploads-list');
      if (files.length === 0) {
        grid.innerHTML = '<p class="muted" style="grid-column:1/-1;text-align:center;padding:20px">No images uploaded yet. Upload images from the Images tab.</p>';
        return;
      }
      grid.innerHTML = files.map((f) => `
        <div style="background:#fafbfc;border-radius:10px;padding:8px;text-align:center;cursor:pointer" class="library-img" data-url="${esc(f.url)}">
          <img class="img-skel" src="${esc(f.url)}" style="width:100%;height:80px;object-fit:cover;border-radius:6px" loading="lazy" onload="this.classList.remove('img-skel')" onerror="this.classList.remove('img-skel')">
          <p class="muted" style="margin:4px 0;font-size:10px;word-break:break-all">${esc(f.name)}</p>
        </div>`).join('');
      grid.querySelectorAll('.library-img').forEach((el) => {
        el.addEventListener('click', () => {
          const url = el.dataset.url;
          restoreModal();
          clearPendingPhoto(selectedId); // a pending crop must not override the library pick
          document.getElementById(selectedId).value = url;
          document.getElementById(selectedId + '-url').textContent = url;
          const prev = document.getElementById(selectedId + '-prev');
          prev.src = url;
          prev.style.display = 'block';
          toast('Image selected');
        });
      });
    } catch (err) {
      grid.innerHTML = `<p class="muted" style="grid-column:1/-1;color:var(--bad)">Error loading images: ${esc(err.message)}</p>`;
    }
  }
  loadImages();
}
/* ---------- pending photos: crop locally, upload on Save ----------
 * Picking a photo only opens the cropper and keeps the 800x800 JPEG blob in
 * memory (keyed by the photo-field id). Nothing hits the network until the
 * form's Save button runs flushPendingPhoto(), so Save is the single step
 * that uploads the image and then saves the record. */
const pendingPhotos = {}; // id -> { blob, name, objUrl }

function clearPendingPhoto(id) {
  const p = pendingPhotos[id];
  if (!p) return;
  URL.revokeObjectURL(p.objUrl);
  delete pendingPhotos[id];
}

/** Sync the preview thumbnail + URL label with either the pending crop or the saved URL. */
function refreshPhotoPreview(id) {
  const hidden = document.getElementById(id);
  const prev = document.getElementById(id + '-prev');
  const label = document.getElementById(id + '-url');
  if (!hidden || !prev || !label) return;
  const pending = pendingPhotos[id];
  if (pending) {
    prev.src = pending.objUrl;
    prev.style.display = 'block';
    label.textContent = `New photo ready (${formatFileSize(pending.blob.size)}) — will upload on Save`;
  } else {
    prev.src = bustImg(hidden.value);
    prev.style.display = hidden.value ? 'block' : 'none';
    label.textContent = hidden.value || 'No photo';
  }
}

/**
 * The single upload step used by every Save handler: if the field has a
 * pending cropped photo, upload it, write the URL into the hidden input and
 * clear the pending state. Returns the final photo URL (or null).
 */
async function flushPendingPhoto(id) {
  const pending = pendingPhotos[id];
  if (!pending) return document.getElementById(id)?.value || null;
  toast(`Uploading photo (${formatFileSize(pending.blob.size)})...`);
  const file = new File([pending.blob], pending.name, { type: 'image/jpeg' });
  const url = await uploadImage(file);
  clearPendingPhoto(id);
  const hidden = document.getElementById(id);
  if (hidden) hidden.value = url;
  refreshPhotoPreview(id);
  return url;
}

function bindPhotoField(id) {
  const input = document.getElementById(id + '-file');
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) return;
    openCropper(file, (croppedBlob) => {
      // No upload here anymore — keep the cropped blob for the Save button.
      clearPendingPhoto(id);
      pendingPhotos[id] = {
        blob: croppedBlob,
        name: file.name.replace(/\.[^.]+$/, '') + '.jpg',
        objUrl: URL.createObjectURL(croppedBlob),
      };
      refreshPhotoPreview(id);
      toast('Crop ready — press Save to upload it');
    });
    input.value = ''; // allow picking the same file again
  });
  // Bind the "From Library" button
  const libraryBtn = document.getElementById(id + '-library-btn');
  if (libraryBtn) {
    libraryBtn.addEventListener('click', () => openImageLibrary(id));
  }
  refreshPhotoPreview(id); // re-sync preview after a modal restore (image library)
}

/* ================= IMAGE CROPPER =================
 * Square crop: drag to pan, slider to zoom. Exports a 800x800 JPEG blob that
 * is handed to the caller — the actual upload happens on the form's Save
 * button (see flushPendingPhoto). Images are always output square (Messenger
 * carousels crop 1:1 anyway). */
let cropCtx = null;
function openCropper(file, onDone) {
  const overlay = document.getElementById('crop-overlay');
  const img = document.getElementById('crop-img');
  const stage = document.getElementById('crop-stage');
  const zoomInput = document.getElementById('crop-zoom');
  const url = URL.createObjectURL(file);

  cropCtx = { onDone, objUrl: url };
  const onImgReady = () => {
    cropCtx.natW = img.naturalWidth;
    cropCtx.natH = img.naturalHeight;
    if (!cropCtx.natW) { toast('Could not read image', true); closeCropper(); return; }
    zoomInput.value = '1';
    cropCtx.zoom = 1;
    cropCtx.x = 0; cropCtx.y = 0;
    // Show the overlay FIRST: the stage has zero size while the overlay is
    // display:none, so measuring it before .show computed scale = 0 — leaving
    // a blank preview and a blank crop output until the user happened to drag
    // or zoom (which re-measured). This was the intermittent "cropper fails".
    overlay.classList.add('show');
    applyCropTransform();
  };
  img.onload = onImgReady;
  img.onerror = () => { toast('Could not load image', true); closeCropper(); };
  img.src = url;
  // if the image finished loading before this handler ran (cache), fire now
  if (img.complete && img.naturalWidth) onImgReady();

  function applyCropTransform() {
    // base scale: smallest side fills the stage (cover)
    const s0 = Math.max(stage.clientWidth / cropCtx.natW, stage.clientHeight / cropCtx.natH);
    cropCtx.scale = s0 * cropCtx.zoom;
    // Clamp the pan so the image always covers the square — dragging it out of
    // the frame used to export transparent (=> black) areas in the JPEG.
    const maxX = Math.max(0, (cropCtx.natW * cropCtx.scale - stage.clientWidth) / 2);
    const maxY = Math.max(0, (cropCtx.natH * cropCtx.scale - stage.clientHeight) / 2);
    cropCtx.x = Math.min(maxX, Math.max(-maxX, cropCtx.x || 0));
    cropCtx.y = Math.min(maxY, Math.max(-maxY, cropCtx.y || 0));
    img.style.width = cropCtx.natW + 'px';
    img.style.height = cropCtx.natH + 'px';
    img.style.transform = `translate(calc(-50% + ${cropCtx.x}px), calc(-50% + ${cropCtx.y}px)) scale(${cropCtx.scale})`;
  }
  cropCtx.apply = applyCropTransform;

  // --- drag to pan ---
  let dragging = null;
  const start = (e) => {
    const t = e.touches ? e.touches[0] : e;
    dragging = { sx: t.clientX, sy: t.clientY, ox: cropCtx.x, oy: cropCtx.y };
    e.preventDefault();
  };
  const move = (e) => {
    if (!dragging) return;
    const t = e.touches ? e.touches[0] : e;
    cropCtx.x = dragging.ox + (t.clientX - dragging.sx);
    cropCtx.y = dragging.oy + (t.clientY - dragging.sy);
    applyCropTransform();
    e.preventDefault();
  };
  const end = () => { dragging = null; };
  stage.onmousedown = start; stage.onmousemove = move; stage.onmouseup = end; stage.onmouseleave = end;
  stage.ontouchstart = start; stage.ontouchmove = move; stage.ontouchend = end;

  // --- wheel zoom ---
  stage.onwheel = (e) => {
    e.preventDefault();
    zoomInput.value = Math.min(3, Math.max(1, cropCtx.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
    cropCtx.zoom = parseFloat(zoomInput.value);
    applyCropTransform();
  };
  zoomInput.oninput = () => { cropCtx.zoom = parseFloat(zoomInput.value); applyCropTransform(); };
}

function closeCropper() {
  document.getElementById('crop-overlay').classList.remove('show');
  if (cropCtx?.objUrl) URL.revokeObjectURL(cropCtx.objUrl);
  cropCtx = null;
}
// Keep the crop geometry in sync while the cropper is open (phone rotation,
// window resize). Harmless no-op when the cropper is closed.
window.addEventListener('resize', () => { if (cropCtx && cropCtx.apply) cropCtx.apply(); });

document.getElementById('crop-cancel').addEventListener('click', closeCropper);
document.getElementById('crop-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'crop-overlay') closeCropper();
});
document.getElementById('crop-apply').addEventListener('click', () => {
  if (!cropCtx) return;
  const OUT = 800; // output resolution (square)
  const img = document.getElementById('crop-img');
  const stage = document.getElementById('crop-stage');
  // Re-run the live transform so the math below matches exactly what the user
  // sees right now (self-heals stale scale from resizes), then validate the
  // geometry — drawing with a zero/NaN scale silently exported a blank image.
  if (typeof cropCtx.apply === 'function') cropCtx.apply();
  const scaleOk = cropCtx.scale > 0 && isFinite(cropCtx.scale);
  if (!scaleOk || !img.naturalWidth || !stage.clientWidth) {
    toast('Crop failed — image not ready, try again', true);
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = OUT; canvas.height = OUT;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  // crop window in natural image coords: stage center + pan offset, scaled
  const cw = stage.clientWidth / cropCtx.scale, ch = stage.clientHeight / cropCtx.scale;
  const cx = cropCtx.natW / 2 - cropCtx.x / cropCtx.scale;
  const cy = cropCtx.natH / 2 - cropCtx.y / cropCtx.scale;
  const side = Math.min(cw, ch);
  ctx.drawImage(img, cx - side / 2, cy - side / 2, side, side, 0, 0, OUT, OUT);
  canvas.toBlob((blob) => {
    const done = cropCtx.onDone;
    closeCropper();
    if (blob) done(blob); else toast('Crop failed', true);
  }, 'image/jpeg', 0.9);
});
window.imgFail = (el) => { const s = document.createElement('span'); s.className = 'thumb noimg'; s.textContent = '🖼️'; el.replaceWith(s); };
/** Thumbnail with graceful fallback when there is no photo or it fails to load. */
const imgTag = (url, title = '') => url
  ? `<img class="thumb img-skel" src="${esc(bustImg(url))}" alt="" title="${esc(title)}" onload="this.classList.remove('img-skel')" onerror="imgFail(this)">`
  : '<span class="thumb noimg" title="No photo">🖼️</span>';
/* ================= DASHBOARD ================= */
views.dashboard = async (main) => {
  const d = await api('/dashboard');
  updateAppBadge(d.pendingOrders || 0);
  const slotRows = d.todayReservations.length
    ? d.todayReservations.map((r) =>
      `<div class="slot-row"><span>${esc(r.time_slot)} — ${esc(r.customer_name)}</span><span class="badge b-${esc(r.status)}">${esc(r.status)}</span></div>`).join('')
    : '<p class="muted">No reservations today.</p>';
  const orderRows = d.recentOrders.map((o) => `
    <tr>
      <td><b>${esc(o.order_number)}</b></td>
      <td>${esc(o.customer_name || '—')}</td>
      <td>${peso(o.total)}</td>
      <td><span class="badge b-${esc(o.status)}">${esc(o.status)}</span></td>
      <td>${esc((o.created_at || '').slice(0, 16))}</td>
    </tr>`).join('');
  main.innerHTML = `
    <h2 class="page-title">Dashboard</h2>
    <div class="cards">
      <div class="stat"><div class="lbl">Today's Orders</div><div class="num">${d.todayOrders}</div></div>
      <div class="stat"><div class="lbl">Pending Orders</div><div class="num">${d.pendingOrders}</div></div>
      <div class="stat"><div class="lbl">Today's Sales</div><div class="num">${peso(d.todaySales)}</div></div>
      <div class="stat"><div class="lbl">Today's Reservations</div><div class="num">${d.todayReservations.length}</div></div>
    </div>
    <div class="card"><h3>📅 Today's Reservations</h3>${slotRows}</div>
    <div class="card"><h3>🛒 Recent Orders</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Order</th><th>Customer</th><th>Total</th><th>Status</th><th>Placed</th></tr></thead>
        <tbody>${orderRows || '<tr><td colspan="5" class="muted">No orders yet.</td></tr>'}</tbody>
      </table></div>
    </div>`;
};

/* ================= ORDERS ================= */
const NEXT_STATUS = { PENDING: 'CONFIRMED', CONFIRMED: 'PREPARING', PREPARING: 'READY', READY: 'COMPLETED' };
// ---------- Order / reservation editors (customer change of mind) ----------
/** Active slot labels for schedule dropdowns (fresh on every open — the table is tiny). */
async function activeSlotLabels() {
  try { return (await api('/time-slots')).filter((s) => s.active).map((s) => s.label); }
  catch { return []; }
}
/** Slot dropdown keeping the current label selectable even if it was retired. */
function slotSelectHtml(id, current, slots) {
  const labels = [...new Set([...slots, current].filter(Boolean))];
  return `<select id="${id}">${labels.map((l) => `<option${l === current ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}
/** Full order editor: add items from the menu/packages/food packs, change
 *  quantities & sizes, remove items, and update details & schedule. Saving
 *  syncs the linked reservation and notifies the customer of the changes. */
async function openOrderEditor(orderId) {
  let order;
  try { order = await api('/orders/' + orderId); } catch { return toast('Could not load the order', true); }
  const [slots, allProducts, allPackages, allFoodPacks] = await Promise.all([
    activeSlotLabels(), api('/products'), api('/packages'), api('/food-packs').catch(() => []),
  ]);
  const catalogs = {
    products: allProducts.filter((p) => p.active && !p.unavailable),
    packages: allPackages.filter((p) => p.active),
    foodPacks: (allFoodPacks || []).filter((f) => f.active),
  };
  // Editable line state: existing lines keep their DB id; pending lines
  // (isNew) are created on save. The server re-prices every line.
  let seq = 0;
  const items = (order.items || []).map((it) => ({
    key: 'x' + it.id, id: it.id, isNew: false, remove: false,
    kind: it.package_id ? 'package' : (it.food_pack_id ? 'foodpack' : 'product'),
    product_id: it.product_id || null, package_id: it.package_id || null, food_pack_id: it.food_pack_id || null,
    name: it.name, variant_size: it.variant_size || '', unit_price: Number(it.unit_price) || 0,
    discount: Number(it.discount) || 0, // Package discount per unit
    quantity: it.quantity, origQty: it.quantity, origSize: it.variant_size || '',
    package_items: it.package_items || [],
  }));
  // Net price = unit_price - discount (for packages with discounts)
  const netUnitPrice = (it) => Math.max(0, it.unit_price - (it.discount || 0));
  const lineSum = () => items.filter((x) => !x.remove).reduce((s, x) => s + netUnitPrice(x) * x.quantity, 0);
  const totalDiscount = () => items.filter((x) => !x.remove).reduce((s, x) => s + (x.discount || 0) * x.quantity, 0) + currentDiscount;
  const currentDiscount = Number(order.additional_discount) || 0;
  const currentDeliveryFee = Number(order.delivery_fee) || 0;
  modal(`<h3>✏️ Edit Order ${esc(order.order_number)}</h3>
    <p class="muted" style="margin-bottom:12px">Customer changed their mind? Add or remove items, change sizes or the schedule — the linked reservation stays in sync and the customer is notified.</p>
    <div class="oe-add-section">
      <div class="oe-section-title">➕ Add items</div>
      <div class="row">
        <select id="oe-kind" style="width:auto"><option value="product">🍽️ Menu item</option><option value="package">🔥 Package</option><option value="foodpack">🍱 Food pack</option></select>
        <select id="oe-add-item" style="flex:1;min-width:150px"></select>
        <select id="oe-add-size" style="width:auto"></select>
        <input type="number" id="oe-add-qty" min="1" max="99" value="1" style="width:58px">
        <button class="btn sm" type="button" id="oe-add">＋ Add</button>
      </div>
    </div>
    <div class="card" style="box-shadow:none;border:1px solid #eee;padding:12px;margin-bottom:10px">
      <b>🧾 Items</b>
      <div id="oe-items" style="margin-top:6px"></div>
      <div id="oe-totals" class="oe-totals-bar" style="margin-top:10px"></div>
    </div>
    <div class="card" style="box-shadow:none;border:1px solid #eee;padding:12px;margin-bottom:10px">
      <b>📋 Details</b>
      <div class="row2" style="margin-top:6px">
        <div class="field"><label>Order type</label>
          <select id="oe-type"><option value="delivery"${order.order_type === 'delivery' ? ' selected' : ''}>🚚 Delivery</option><option value="pickup"${order.order_type === 'pickup' ? ' selected' : ''}>🏬 Pickup</option></select></div>
        <div class="field"><label>Contact number</label><input id="oe-phone" value="${esc(order.customer_phone || '')}"></div>
      </div>
      <div class="field"><label>Delivery address</label><input id="oe-address" value="${esc(order.address || '')}"></div>
    </div>
    <div class="card" style="box-shadow:none;border:1px solid #eee;padding:12px;margin-bottom:10px">
      <b>📅 Schedule</b>
      <div class="row2" style="margin-top:6px">
        <div class="field"><label>Date</label><input type="date" id="oe-date" value="${esc(order.fulfillment_date || '')}"></div>
        <div class="field"><label>Time slot</label>${slotSelectHtml('oe-slot', order.time_slot, slots)}</div>
      </div>
      <div class="field"><label>Notes</label><textarea id="oe-notes" rows="2">${esc(order.notes || '')}</textarea></div>
    </div>
    <div id="oe-summary" class="oe-totals-bar" style="margin-bottom:10px"></div>
    <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" id="oe-save">Save changes</button></div>`);
  // ---- item row renderer + live events (list re-renders on any change) ----
  const itemsEl = document.getElementById('oe-items');
  const totalsEl = document.getElementById('oe-totals');
  const itemRow = (it) => {
    const meta = it.kind === 'product' ? catalogs.products.find((x) => x.id == it.product_id)
      : it.kind === 'package' ? catalogs.packages.find((x) => x.id == it.package_id)
      : catalogs.foodPacks.find((x) => x.id == it.food_pack_id);
    const thumb = meta && meta.photo_url ? imgTag(meta.photo_url, it.name) : '<span class="thumb noimg" title="No photo">🖼️</span>';
    const sizes = it.kind === 'product' ? (meta?.variants || []).map((v) => v.size)
      : it.kind === 'package' ? ['M', 'L'] : [];
    const sizeSel = sizes.length ? `<select class="oe-size" title="Size" style="width:auto">${[...new Set([...sizes, it.variant_size].filter(Boolean))].map((s) => `<option${s === it.variant_size ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>` : '';
    const slots = (it.package_items || []).length ? `<div class="muted" style="font-size:11px">${it.package_items.filter(Boolean).map((p) => 'S' + p.slot_number + ': ' + esc(p.product_name)).join(' · ')}</div>` : '';
    return `<div class="oe-item-row${it.remove ? ' oe-removed' : ''}" data-key="${it.key}" data-item-id="${it.id || ''}" data-qty="${it.quantity}" style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid #f0f1f3">
      ${thumb}
      <div style="flex:1;min-width:0">
        <div><b>${esc(it.name)}</b>${it.isNew ? ' <span class="badge b-CONFIRMED">NEW</span>' : ''}</div>
        ${slots}
        <div class="muted" style="font-size:11px">${peso(netUnitPrice(it))} each${it.discount > 0 ? ` <span style="color:#27ae60">(was ${peso(it.unit_price)}, save ${peso(it.discount)})</span>` : ''}</div>
      </div>
      ${sizeSel}
      <div style="display:flex;align-items:center;gap:3px">
        <button class="btn ghost sm" type="button" data-oe-step="-1" style="padding:2px 7px">−</button>
        <input type="number" class="oe-qty oe-qty-input" min="0" max="99" value="${it.quantity}">
        <button class="btn ghost sm" type="button" data-oe-step="1" style="padding:2px 7px">＋</button>
      </div>
      <span class="oe-line-total">${peso(netUnitPrice(it) * it.quantity)}</span>
      <button class="btn danger sm" type="button" data-oe-del title="${it.isNew ? 'Remove row' : 'Remove item'}">✕</button>
    </div>`;
  };
  const renderItems = () => {
    const hasItems = items.filter((x) => !x.remove).length > 0;
    itemsEl.innerHTML = items.map(itemRow).join('') || '<p class="muted">No items.</p>';
    const netTotal = lineSum(); // Sum of net prices (after package discounts)
    const grossTotal = items.filter((x) => !x.remove).reduce((s, x) => s + x.unit_price * x.quantity, 0);
    const pkgDiscounts = items.filter((x) => !x.remove).reduce((s, x) => s + (x.discount || 0) * x.quantity, 0);
    const estimatedTotal = Math.max(0, netTotal - currentDiscount + currentDeliveryFee);
    totalsEl.innerHTML = hasItems
      ? `<div style="font-size:1.1rem;font-weight:700">Total: ${peso(estimatedTotal)}</div><div style="font-size:0.85rem;color:#666">Items: ${peso(grossTotal)}${pkgDiscounts > 0 ? ` − Package savings: ${peso(pkgDiscounts)}` : ''}${currentDiscount > 0 ? ` − Discount: ${peso(currentDiscount)}` : ''}${currentDeliveryFee > 0 ? ` + Delivery: ${peso(currentDeliveryFee)}` : ''}</div>`
      : '';
  };
  // helpful hint shown below the items list
  const hintEl = document.createElement('div');
  hintEl.className = 'muted';
  hintEl.style.fontSize = '11px';
  hintEl.style.marginTop = '6px';
  hintEl.textContent = 'Set quantity to 0 or press ✕ to remove a line.';
  itemsEl.parentNode.insertBefore(hintEl, itemsEl.nextSibling);
  itemsEl.addEventListener('click', (e) => {
    const row = e.target.closest('.oe-item-row');
    if (!row) return;
    const it = items.find((x) => x.key === row.dataset.key);
    if (!it) return;
    const step = e.target.closest('[data-oe-step]');
    if (step) { it.quantity = Math.max(0, Math.min(99, it.quantity + Number(step.dataset.oeStep))); renderItems(); return; }
    if (e.target.closest('[data-oe-del]')) {
      if (it.isNew) items.splice(items.indexOf(it), 1);
      else it.remove = !it.remove;
      renderItems();
    }
  });
  itemsEl.addEventListener('input', (e) => {
    const row = e.target.closest('.oe-item-row');
    if (!row) return;
    const it = items.find((x) => x.key === row.dataset.key);
    if (!it) return;
    if (e.target.classList.contains('oe-qty')) {
      it.quantity = Math.max(0, Math.min(99, Number(e.target.value) || 0));
    } else if (e.target.classList.contains('oe-size')) {
      it.variant_size = e.target.value;
      const meta = catalogs.products.find((x) => x.id == it.product_id);
      const v = (meta?.variants || []).find((x) => x.size === it.variant_size);
      if (v) it.unit_price = Number(v.price);
    }
    row.querySelector('.oe-line-total').textContent = peso(netUnitPrice(it) * it.quantity);
    const netTotal = lineSum();
    const grossTotal = items.filter((x) => !x.remove).reduce((s, x) => s + x.unit_price * x.quantity, 0);
    const pkgDiscounts = items.filter((x) => !x.remove).reduce((s, x) => s + (x.discount || 0) * x.quantity, 0);
    const estimatedTotal = Math.max(0, netTotal - currentDiscount + currentDeliveryFee);
    totalsEl.innerHTML = items.filter((x) => !x.remove).length > 0
      ? `<div style="font-size:1.1rem;font-weight:700">Total: ${peso(estimatedTotal)}</div><div style="font-size:0.85rem;color:#666">Items: ${peso(grossTotal)}${pkgDiscounts > 0 ? ` − Package savings: ${peso(pkgDiscounts)}` : ''}${currentDiscount > 0 ? ` − Discount: ${peso(currentDiscount)}` : ''}${currentDeliveryFee > 0 ? ` + Delivery: ${peso(currentDeliveryFee)}` : ''}</div>`
      : '';
  });
  renderItems();
  // ---- add-item picker (menu items / packages / food packs) ----
  const kindSel = document.getElementById('oe-kind');
  const itemSel = document.getElementById('oe-add-item');
  const addSizeSel = document.getElementById('oe-add-size');
  const fillSizeOptions = () => {
    const id = Number(itemSel.value);
    if (kindSel.value === 'product') {
      const p = catalogs.products.find((x) => x.id === id);
      const sizes = (p?.variants || []).map((v) => v.size);
      addSizeSel.innerHTML = sizes.length ? sizes.map((s) => `<option>${esc(s)}</option>`).join('') : '<option value="">—</option>';
      addSizeSel.disabled = sizes.length === 0;
    } else if (kindSel.value === 'package') {
      addSizeSel.innerHTML = '<option>M</option><option>L</option>';
      addSizeSel.disabled = false;
    } else {
      addSizeSel.innerHTML = '<option value="">—</option>';
      addSizeSel.disabled = true;
    }
  };
  const fillItemOptions = () => {
    if (kindSel.value === 'product') {
      itemSel.innerHTML = catalogs.products.map((p) => {
        const vs = (p.variants || []).map((v) => `${v.size} ${peso(v.price)}`).join(' / ');
        return `<option value="${p.id}">${esc(p.name)}${vs ? ' — ' + esc(vs) : ' — no price set'}</option>`;
      }).join('') || '<option value="">No menu items yet</option>';
    } else if (kindSel.value === 'package') {
      itemSel.innerHTML = catalogs.packages.map((p) => `<option value="${p.id}">${esc(p.name)} — ${peso(Math.max(0, (p.base_price || 0) - (p.discount || 0)))}</option>`).join('') || '<option value="">No packages yet</option>';
    } else {
      itemSel.innerHTML = catalogs.foodPacks.map((f) => `<option value="${f.id}">${esc(f.name)} — ${peso(f.price)}</option>`).join('') || '<option value="">No food packs yet</option>';
    }
    fillSizeOptions();
  };
  kindSel.addEventListener('change', fillItemOptions);
  itemSel.addEventListener('change', fillSizeOptions);
  fillItemOptions();
  document.getElementById('oe-add').addEventListener('click', () => {
    const id = Number(itemSel.value);
    if (!id) { toast('Nothing to add — create it in Menu / Packages first.', true); return; }
    const qty = Math.max(1, Math.min(99, Number(document.getElementById('oe-add-qty').value) || 1));
    const size = addSizeSel.disabled ? '' : addSizeSel.value;
    let it;
    if (kindSel.value === 'product') {
      const p = catalogs.products.find((x) => x.id === id);
      const v = (p?.variants || []).find((x) => x.size === size) || (p?.variants || [])[0];
      it = { key: 'n' + (++seq), isNew: true, remove: false, kind: 'product', product_id: id, package_id: null, food_pack_id: null, name: p.name + (size ? ` (${size})` : ''), variant_size: size || '', unit_price: v ? Number(v.price) : 0, quantity: qty, origQty: 0, origSize: '', package_items: [] };
    } else if (kindSel.value === 'package') {
      const p = catalogs.packages.find((x) => x.id === id);
      it = { key: 'n' + (++seq), isNew: true, remove: false, kind: 'package', product_id: null, package_id: id, food_pack_id: null, name: p.name + (size ? ` (${size})` : ''), variant_size: size || '', unit_price: Number(p.base_price) || 0, discount: Number(p.discount) || 0, quantity: qty, origQty: 0, origSize: '', package_items: [] };
    } else {
      const f = catalogs.foodPacks.find((x) => x.id === id);
      it = { key: 'n' + (++seq), isNew: true, remove: false, kind: 'foodpack', product_id: null, package_id: null, food_pack_id: id, name: f.name + ' (food pack)', variant_size: '', unit_price: Number(f.price) || 0, quantity: qty, origQty: 0, origSize: '', package_items: [] };
    }
    items.push(it);
    renderItems();
  });
  document.getElementById('oe-save').addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
    try {
      // Process each row: new items are created, existing items are updated or removed.
      for (const row of document.querySelectorAll('#oe-items .oe-item-row')) {
        const itemId = row.dataset.itemId ? Number(row.dataset.itemId) : null;
        const origQty = Number(row.dataset.qty) || 0;
        const qty = Math.max(0, Math.min(99, Number(row.querySelector('.oe-qty').value) || 0));
        const isNew = !itemId;
        if (isNew) {
          if (qty === 0) continue;
          const it = items.find((x) => x.key === row.dataset.key);
          if (!it) continue;
          if (it.kind === 'product') await api(`/orders/${orderId}/items`, { method: 'POST', body: { product_id: it.product_id, variant_size: it.variant_size || undefined, quantity: qty } });
          else if (it.kind === 'package') await api(`/orders/${orderId}/items`, { method: 'POST', body: { package_id: it.package_id, variant_size: it.variant_size || undefined, quantity: qty } });
          else if (it.kind === 'foodpack') await api(`/orders/${orderId}/items`, { method: 'POST', body: { food_pack_id: it.food_pack_id, quantity: qty } });
          continue;
        }
        if (qty === origQty) continue;
        if (qty === 0) await api(`/orders/${orderId}/items/${itemId}`, { method: 'DELETE' });
        else await api(`/orders/${orderId}/items/${itemId}`, { method: 'PUT', body: { quantity: qty } });
      }
      // Only include schedule fields if the date is filled — sending empty date
      // without a slot (or vice versa) would trip the backend's validation.
      const dateVal = document.getElementById('oe-date').value;
      const slotVal = document.getElementById('oe-slot').value;
      const putBody = {
        order_type: document.getElementById('oe-type').value,
        phone: document.getElementById('oe-phone').value.trim(),
        address: document.getElementById('oe-address').value.trim(),
        notes: document.getElementById('oe-notes').value.trim(),
      };
      if (dateVal && slotVal) {
        putBody.fulfillment_date = dateVal;
        putBody.time_slot = slotVal;
      }
      await api('/orders/' + orderId, { method: 'PUT', body: putBody });
      closeModal();
      toast('Order updated — the customer was notified of the changes');
      navigate('orders');
    } catch (err) { toast(err.message || 'Could not save the changes', true); }
  }));
}
/** Reservation editor: name, phone, schedule, notes — mirrored to the linked order. */
async function openReservationEditor(resvId, r) {
  const slots = await activeSlotLabels();
  modal(`<h3>✏️ Edit Reservation</h3>
    <p class="muted" style="margin-bottom:10px">${r.order_id ? 'Linked to order #' + esc(String(r.order_id)) + ' — schedule and notes changes apply to both.' : 'Standalone reservation — not linked to an order.'}</p>
    <div class="field"><label>Customer name</label><input id="re-name" value="${esc(r.customer_name || '')}"></div>
    <div class="field"><label>Contact number</label><input id="re-phone" value="${esc(r.phone || '')}"></div>
    <div class="row2">
      <div class="field"><label>Date</label><input type="date" id="re-date" value="${esc(r.res_date || '')}"></div>
      <div class="field"><label>Time slot</label>${slotSelectHtml('re-slot', r.time_slot, slots)}</div>
    </div>
    <div class="field"><label>Notes</label><textarea id="re-notes" rows="2">${esc(r.notes || '')}</textarea></div>
    <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" id="re-save">Save changes</button></div>`);
  document.getElementById('re-save').addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
    try {
      await api('/reservations/' + resvId, { method: 'PUT', body: {
        customer_name: document.getElementById('re-name').value.trim(),
        phone: document.getElementById('re-phone').value.trim(),
        res_date: document.getElementById('re-date').value,
        time_slot: document.getElementById('re-slot').value,
        notes: document.getElementById('re-notes').value.trim(),
      } });
      closeModal();
      toast('Reservation updated');
      navigate('reservations');
    } catch (err) { toast(err.message || 'Could not save the changes', true); }
  }));
}
views.orders = async (main) => {
  main.innerHTML = `
    <h2 class="page-title">Orders</h2>
    <div class="card"><div id="orders-body"><p class="muted">Loading…</p></div></div>`;
  const filter = sessionStorage.getItem('orderFilter') || '';
  const orders = await api('/orders' + (filter ? '?status=' + filter : ''));
  const pendingCount = orders.filter((o) => o.status === 'PENDING').length;
  updateAppBadge(pendingCount);
  const filters = ['', 'PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'];
  const selected = new Set();
  const renderBulkBar = () => {
    const bar = main.querySelector('#order-bulk');
    if (!bar) return;
    bar.style.display = selected.size ? 'flex' : 'none';
    const count = main.querySelector('#order-bulk-count');
    if (count) count.textContent = `${selected.size} selected`;
    const adv = main.querySelector('#order-bulk-advance');
    if (adv) adv.disabled = !orders.some((o) => selected.has(o.id) && NEXT_STATUS[o.status]);
    const paid = main.querySelector('#order-bulk-paid');
    if (paid) paid.disabled = !orders.some((o) => selected.has(o.id) && o.payment_status !== 'PAID');
    const cancel = main.querySelector('#order-bulk-cancel');
    if (cancel) cancel.disabled = !orders.some((o) => selected.has(o.id) && o.status !== 'CANCELLED' && o.status !== 'COMPLETED');
    const del = main.querySelector('#order-bulk-del');
    if (del) del.disabled = selected.size === 0;
  };
  main.querySelector('#orders-body').innerHTML = `
    <div class="oc-select-head">
      <input type="checkbox" id="order-check-all" title="Select all">
      <span>Select all</span>
      <select id="order-filter" style="width:auto;margin-left:auto">
        ${filters.map((f) => `<option value="${f}" ${f === filter ? 'selected' : ''}>${f || 'All statuses'}</option>`).join('')}
      </select>
    </div>
    <div id="order-bulk" style="display:none;margin-bottom:10px;padding:8px 12px;background:#eef2ff;border:1px solid #c7d2fe;border-radius:8px;align-items:center;gap:8px;flex-wrap:wrap">
      <b id="order-bulk-count">0 selected</b>
      <button class="btn ok sm" id="order-bulk-advance">→ Advance</button>
      <button class="btn ghost sm" id="order-bulk-paid">Mark Paid</button>
      <button class="btn danger sm" id="order-bulk-cancel">Cancel</button>
      ${ROLE === 'ADMIN' ? `<button class="btn danger sm" id="order-bulk-del">🗑 Delete</button><button class="btn danger sm" id="order-bulk-reset">🔄 Reset all</button>` : ''}
      <button class="btn ghost sm" id="order-bulk-clear">✕ Clear</button>
    </div>
    <div class="oc-grid">
      ${orders.map((o) => {
        const itemChips = (o.items || []).map((i) => {
          const label = `${esc(i.name)}${i.variant_size ? ` (${esc(i.variant_size)})` : ''} ×${i.quantity}`;
          const dishes = (i.package_items || []).filter(Boolean).map((p) => `S${p.slot_number}: ${esc(p.product_name)}`).join(' · ');
          return `<span class="oc-chip"${dishes ? ` title="${label} · ${dishes}"` : ''}${(i.package_items || []).length ? '>🧺 ' : '>'}${label}</span>`;
        }).join('') || '<span class="muted" style="font-size:12px">No items</span>';
        return `
        <div class="oc-card">
          <div class="oc-head">
            <label class="oc-check"><input type="checkbox" class="order-check" value="${o.id}" title="Select order"></label>
            <div class="oc-title"><b>${esc(o.order_number)}</b> <span class="muted" style="font-size:12px">· ${esc((o.created_at || '').slice(0, 10))}</span></div>
            <span class="badge b-${esc(o.status)}">${esc(o.status)}</span>
          </div>
          <div class="oc-cust">
            <span class="oc-line">👤 ${esc(o.customer_name || '—')} <span class="muted">${esc(o.phone || '')}</span></span>
            <span class="oc-line">${o.order_type === 'delivery' ? '🚚 ' + esc(o.address || '') : '🏬 Pickup'}</span>
            ${o.fulfillment_date ? `<span class="oc-line">📅 ${esc(o.fulfillment_date)} <span class="muted">${esc(o.time_slot || '')}</span></span>` : ''}
            <span class="oc-line"><span class="badge b-${esc(o.payment_status)}">${esc(o.payment_status)}</span>${o.payment_method ? ` <span class="muted">${esc(o.payment_method)}</span>` : ''}</span>
          </div>
          <div class="oc-items">${itemChips}</div>
          <div class="oc-foot">
            <div><span class="oc-total">${peso(o.total)}</span>${o.additional_discount ? `<div class="oc-sub">incl. − ${peso(o.additional_discount)} discount</div>` : ''}</div>
            <div class="oc-actions">
              ${NEXT_STATUS[o.status] ? `<button class="btn ok sm" data-advance="${o.id}" data-next="${NEXT_STATUS[o.status]}">→ ${NEXT_STATUS[o.status]}</button>` : (o.status === 'COMPLETED' ? '<span class="muted" style="font-size:12px">Done</span>' : '')}
              <div class="row-menu-wrap">
                <button class="btn ghost sm" data-menu-btn title="More actions" aria-haspopup="true">⋯</button>
                <div class="row-menu">
                  ${o.status === 'READY' && o.order_type === 'delivery' ? `<button class="btn ghost sm" data-otw="${o.id}">🛵 Rider OTW</button>` : ''}
                  ${o.status !== 'CANCELLED' && o.status !== 'COMPLETED' ? `<button class="btn ghost sm" data-edit-order="${o.id}" title="Edit order (change of mind)">✏️ Edit</button>` : ''}
                  <button class="btn ghost sm" data-booking="${o.id}" title="Generate booking details">📋 Booking</button>
                  ${o.status !== 'CANCELLED' && o.status !== 'COMPLETED' ? `<button class="btn danger sm" data-cancel="${o.id}">✕ Cancel order</button>` : ''}
                  ${o.payment_status !== 'PAID' ? `<button class="btn ghost sm" data-paid="${o.id}">💰 Mark Paid</button>` : ''}
                  <button class="btn ghost sm" data-discount="${o.id}">% Discount</button>
                  ${ROLE === 'ADMIN' ? `<button class="btn danger sm" data-del-order="${o.id}" title="Permanently delete">🗑 Delete</button>` : ''}
                </div>
              </div>
            </div>
          </div>
        </div>`;}).join('') || '<div class="oc-empty">No orders.</div>'}
    </div>`;
  main.querySelector('#order-filter').addEventListener('change', (e) => {
    sessionStorage.setItem('orderFilter', e.target.value);
    navigate('orders');
  });
  main.querySelectorAll('[data-advance]').forEach((b) => b.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
    await api(`/orders/${b.dataset.advance}/status`, { method: 'POST', body: { status: b.dataset.next } }); toast('Order → ' + b.dataset.next); navigate('orders');
  })));
  main.querySelectorAll('[data-otw]').forEach((b) => b.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
    await api(`/orders/${b.dataset.otw}/on-the-way`, { method: 'POST' }); toast('Customer notified: order is on the way 🛵');
  })));
  main.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
    if (!confirm('Cancel this order?')) return;
    await api(`/orders/${b.dataset.cancel}/status`, { method: 'POST', body: { status: 'CANCELLED' } }); toast('Order cancelled'); navigate('orders');
  })));
  main.querySelectorAll('[data-paid]').forEach((b) => b.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
    await api(`/orders/${b.dataset.paid}/payment-status`, { method: 'POST', body: { payment_status: 'PAID' } }); toast('Marked as paid'); navigate('orders');
  })));
  main.querySelectorAll('[data-discount]').forEach((b) => b.addEventListener('click', () => {
    const o = orders.find((x) => x.id == b.dataset.discount);
    modal(`<h3>Deduct Amount — ${esc(o.order_number)}</h3>
      <p class="muted">Current total: <b>${peso(o.total)}</b>${o.additional_discount ? ` (already deducted: ${peso(o.additional_discount)})` : ''}</p>
      <div class="field"><label>Amount to deduct (₱)</label>
        <input type="number" id="od-disc" min="0" value="0"></div>
      <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn" id="od-save">Apply Discount</button></div>`);
    document.getElementById('od-save').addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
      const amount = Math.max(0, Number(document.getElementById('od-disc').value) || 0);
      if (!amount) { closeModal(); return; }
      // add the entered amount on top of whatever has already been deducted
      const totalDisc = (o.additional_discount || 0) + amount;
      await api(`/orders/${o.id}/discount`, { method: 'POST', body: { additional_discount: totalDisc } });
      closeModal(); toast(`Deducted ${peso(amount)} from total`); navigate('orders');
    }));
  }));

  main.querySelectorAll('[data-edit-order]').forEach((b) => b.addEventListener('click', () => openOrderEditor(Number(b.dataset.editOrder))));
  main.querySelectorAll('[data-booking]').forEach((b) => b.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
    const text = await generateBookingDetails(Number(b.dataset.booking));
    // Split off the embedded Waze metadata (not meant for the rider's copy text).
    const wazeUrl = (() => { const m = text.match(/;;;WAZE=(.*)$/); return m ? decodeURIComponent(m[1]) : ''; })();
    const riderText = text.replace(/;;;WAZE=.*$/, '');
    modal(`<h3>📋 Booking Details</h3>
      <p class="muted">Copy and send to your rider or delivery driver.</p>
      <textarea id="booking-text" style="width:100%;height:300px;font-family:monospace;font-size:13px" readonly>${esc(riderText)}</textarea>
      ${wazeUrl ? `<button class="btn" style="width:100%;margin-top:8px;background:#33ccff" onclick="window.open('${wazeUrl}','_blank')">🗺️ Open in Waze — Navigate to Customer</button>` : ''}
      <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Close</button>
      <button class="btn" id="booking-copy">📋 Copy to Clipboard</button></div>`);
    document.getElementById('booking-copy').addEventListener('click', () => {
      const ta = document.getElementById('booking-text');
      ta.select();
      navigator.clipboard.writeText(ta.value).then(() => toast('Booking details copied!')).catch(() => toast('Select and copy manually', true));
    });
  })));

  // ---- Bulk actions ----
  const checkAll = main.querySelector('#order-check-all');
  checkAll.addEventListener('change', () => {
    main.querySelectorAll('.order-check').forEach((b) => {
      b.checked = checkAll.checked;
      if (checkAll.checked) selected.add(Number(b.value)); else selected.delete(Number(b.value));
    });
    renderBulkBar();
  });
  main.querySelectorAll('.order-check').forEach((b) => b.addEventListener('change', () => {
    const id = Number(b.value);
    if (b.checked) selected.add(id); else selected.delete(id);
    const ca = main.querySelector('#order-check-all');
    const boxes = main.querySelectorAll('.order-check');
    if (ca) {
      ca.checked = boxes.length > 0 && [...boxes].every((x) => x.checked);
      ca.indeterminate = selected.size > 0 && !ca.checked;
    }
    renderBulkBar();
  }));
  main.querySelector('#order-bulk-clear').addEventListener('click', () => {
    selected.clear();
    main.querySelectorAll('.order-check').forEach((b) => { b.checked = false; });
    const ca = main.querySelector('#order-check-all');
    if (ca) { ca.checked = false; ca.indeterminate = false; }
    renderBulkBar();
  });
  main.querySelector('#order-bulk-advance').addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
    const targets = orders.filter((o) => selected.has(o.id) && NEXT_STATUS[o.status]);
    if (!targets.length) return toast('No selected orders can be advanced', true);
    if (!confirm(`Advance ${targets.length} order(s) to their next status?`)) return;
    await Promise.all(targets.map((o) => api(`/orders/${o.id}/status`, { method: 'POST', body: { status: NEXT_STATUS[o.status] } })));
    toast(`Advanced ${targets.length} order(s)`); navigate('orders');
  }));
  main.querySelector('#order-bulk-paid').addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
    const targets = orders.filter((o) => selected.has(o.id) && o.payment_status !== 'PAID');
    if (!targets.length) return toast('No selected orders to mark paid', true);
    if (!confirm(`Mark ${targets.length} order(s) as paid?`)) return;
    await Promise.all(targets.map((o) => api(`/orders/${o.id}/payment-status`, { method: 'POST', body: { payment_status: 'PAID' } })));
    toast(`Marked ${targets.length} order(s) as paid`); navigate('orders');
  }));
  main.querySelector('#order-bulk-cancel').addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
    const targets = orders.filter((o) => selected.has(o.id) && o.status !== 'CANCELLED' && o.status !== 'COMPLETED');
    if (!targets.length) return toast('No selected orders can be cancelled', true);
    if (!confirm(`Cancel ${targets.length} order(s)?`)) return;
    await Promise.all(targets.map((o) => api(`/orders/${o.id}/status`, { method: 'POST', body: { status: 'CANCELLED' } })));
    toast(`Cancelled ${targets.length} order(s)`); navigate('orders');
  }));

  // ---- Permanent delete / reset (ADMIN only) ----
  main.querySelectorAll('[data-del-order]').forEach((b) => b.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
    if (!confirm(`Permanently delete order #${b.dataset.delOrder}? This cannot be undone.`)) return;
    await api(`/orders/${b.dataset.delOrder}`, { method: 'DELETE' });
    toast('Order deleted'); navigate('orders');
  })));
  const bulkDel = main.querySelector('#order-bulk-del');
  if (bulkDel) bulkDel.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
    const targets = orders.filter((o) => selected.has(o.id));
    if (!targets.length) return toast('No selected orders to delete', true);
    if (!confirm(`Permanently delete ${targets.length} order(s)? This cannot be undone.`)) return;
    await Promise.all(targets.map((o) => api(`/orders/${o.id}`, { method: 'DELETE' })));
    toast(`Deleted ${targets.length} order(s)`); navigate('orders');
  }));
  const bulkReset = main.querySelector('#order-bulk-reset');
  if (bulkReset) bulkReset.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
    if (!orders.length) return toast('No orders to reset', true);
    if (!confirm('⚠️ This will PERMANENTLY DELETE ALL ORDERS (and their items, ratings, history, and linked reservations). This CANNOT be undone. Continue?')) return;
    if (!confirm('Are you absolutely sure? There is no undo for this action.')) return;
    await api('/orders', { method: 'DELETE' });
    toast('All orders cleared'); navigate('orders');
  }));
};

/* ================= RESERVATIONS ================= */
views.reservations = async (main) => {
  const today = new Date().toISOString().slice(0, 10);
  const date = sessionStorage.getItem('resvDate') || today;
  const f = {
    status: sessionStorage.getItem('resvFStatus') || '',
    slot: sessionStorage.getItem('resvFSlot') || '',
    q: sessionStorage.getItem('resvFQ') || '',
    range: sessionStorage.getItem('resvFRange') || 'all',
    from: sessionStorage.getItem('resvFFrom') || '',
    to: sessionStorage.getItem('resvFTo') || '',
    incCancelled: sessionStorage.getItem('resvFCancel') === '1',
  };
  const selected = new Set();
  const renderResvBulk = (resvs) => {
    const bar = main.querySelector('#resv-bulk');
    if (!bar) return;
    bar.style.display = selected.size ? 'flex' : 'none';
    const count = main.querySelector('#resv-bulk-count');
    if (count) count.textContent = `${selected.size} selected`;
    const ok = main.querySelector('#resv-bulk-confirm');
    if (ok) ok.disabled = !resvs.some((r) => selected.has(r.id) && r.status === 'PENDING');
    const done = main.querySelector('#resv-bulk-complete');
    if (done) done.disabled = !resvs.some((r) => selected.has(r.id) && r.status === 'CONFIRMED');
    const cancel = main.querySelector('#resv-bulk-cancel');
    if (cancel) cancel.disabled = !resvs.some((r) => selected.has(r.id) && r.status !== 'CANCELLED' && r.status !== 'COMPLETED');
    const del = main.querySelector('#resv-bulk-del');
    if (del) del.disabled = selected.size === 0;
  };
  main.innerHTML = `
    <h2 class="page-title">📅 Reservations</h2>
    <div class="card">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
        <input type="date" id="resv-date" value="${date}" style="width:auto">
        <button class="btn sm" id="resv-new">＋ New Reservation</button>
        <span class="muted" id="resv-open"></span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px;padding:10px;background:#fafbfc;border-radius:8px">
        <span class="muted" style="font-size:0.8rem">Filters:</span>
        <select id="resv-f-status" style="width:auto">
          <option value="">All statuses</option>
          <option value="PENDING"${f.status === 'PENDING' ? ' selected' : ''}>Pending</option>
          <option value="CONFIRMED"${f.status === 'CONFIRMED' ? ' selected' : ''}>Confirmed</option>
          <option value="COMPLETED"${f.status === 'COMPLETED' ? ' selected' : ''}>Completed</option>
          <option value="CANCELLED"${f.status === 'CANCELLED' ? ' selected' : ''}>Cancelled</option>
          <option value="PENDING,CONFIRMED"${f.status === 'PENDING,CONFIRMED' ? ' selected' : ''}>Active (P+C)</option>
        </select>
        <select id="resv-f-slot" style="width:auto"><option value="">All time slots</option></select>
        <input type="text" id="resv-f-q" placeholder="Search name or phone…" value="${esc(f.q)}" style="width:170px">
        <select id="resv-f-range" style="width:auto">
          <option value=""${!f.range ? ' selected' : ''}>Selected date</option>
          <option value="range"${f.range === 'range' ? ' selected' : ''}>Date range</option>
          <option value="all"${f.range === 'all' ? ' selected' : ''}>All dates</option>
        </select>
        <span id="resv-f-range-inputs" style="display:${f.range === 'range' ? 'inline-flex' : 'none'};gap:8px;align-items:center">
          <input type="date" id="resv-f-from" value="${f.from}" style="width:auto">
          <span class="muted">→</span>
          <input type="date" id="resv-f-to" value="${f.to}" style="width:auto">
        </span>
        <label style="font-size:0.8rem;display:flex;align-items:center;gap:4px">
          <input type="checkbox" id="resv-f-cancel"${f.incCancelled ? ' checked' : ''}> Show cancelled
        </label>
        <button class="btn ghost sm" id="resv-f-clear">✕ Clear</button>
      </div>
      <div id="resv-stats" style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap"></div>
      <div id="resv-body"><p class="muted">Loading…</p></div>
    </div>`;
  const reload = async () => {
    const params = new URLSearchParams();
    if (f.range === 'all') {
      // no date restriction
    } else if (f.range === 'range') {
      if (f.from) params.set('from', f.from);
      if (f.to) params.set('to', f.to);
    } else {
      params.set('date', date);
    }
    if (f.status) params.set('status', f.status);
    if (f.slot) params.set('slot', f.slot);
    if (f.q) params.set('q', f.q);
    if (f.incCancelled) params.set('include_cancelled', '1');
    const [resvs, avail] = await Promise.all([
      api('/reservations?' + params.toString()), api('/reservations/availability?date=' + date),
    ]);
    main.querySelector('#resv-open').textContent = avail.open.open
      ? `🟢 Open — ${avail.slots.filter((s) => !s.full).length}/${avail.slots.length} slots available`
      : '🔴 CLOSED: ' + (avail.open.reason || '');
    // Populate the time-slot filter from active slots (preserve selection)
    const slotSel = main.querySelector('#resv-f-slot');
    if (slotSel) {
      const prev = slotSel.value;
      slotSel.innerHTML = '<option value="">All time slots</option>' +
        (avail.slots || []).map((s) => `<option value="${esc(s.label)}"${s.label === prev ? ' selected' : ''}>${esc(s.label)}</option>`).join('');
    }
    // Calculate stats
    const pending = resvs.filter(r => r.status === 'PENDING').length;
    const confirmed = resvs.filter(r => r.status === 'CONFIRMED').length;
    const total = resvs.length;

    main.querySelector('#resv-stats').innerHTML = `
      <div style="background:#fff3cd;padding:8px 14px;border-radius:8px;text-align:center">
        <div style="font-size:1.4rem;font-weight:700">${pending}</div>
        <div style="font-size:0.75rem;color:#856404">Pending</div>
      </div>
      <div style="background:#d4edda;padding:8px 14px;border-radius:8px;text-align:center">
        <div style="font-size:1.4rem;font-weight:700">${confirmed}</div>
        <div style="font-size:0.75rem;color:#155724">Confirmed</div>
      </div>
      <div style="background:#e2e3e5;padding:8px 14px;border-radius:8px;text-align:center">
        <div style="font-size:1.4rem;font-weight:700">${total}</div>
        <div style="font-size:0.75rem;color:#383d41">Total</div>
      </div>`;

    main.querySelector('#resv-body').innerHTML = `
      <div id="resv-bulk" style="display:none;margin-bottom:10px;padding:8px 12px;background:#eef2ff;border:1px solid #c7d2fe;border-radius:8px;align-items:center;gap:8px;flex-wrap:wrap">
        <b id="resv-bulk-count">0 selected</b>
        <button class="btn ok sm" id="resv-bulk-confirm">Confirm</button>
        <button class="btn ok sm" id="resv-bulk-complete">Complete</button>
        <button class="btn danger sm" id="resv-bulk-cancel">Cancel</button>
        ${ROLE === 'ADMIN' ? `<button class="btn danger sm" id="resv-bulk-del">🗑 Delete</button><button class="btn danger sm" id="resv-bulk-reset">🔄 Reset all</button>` : ''}
        <button class="btn ghost sm" id="resv-bulk-clear">✕ Clear</button>
      </div>
      <div class="rc-select-head">
        <input type="checkbox" id="resv-check-all" title="Select all">
        <span>Select all</span>
      </div>
      <div class="rc-grid">
        ${resvs.map((r) => `
        <div class="rc-card">
          <div class="rc-head">
            <label class="rc-check"><input type="checkbox" class="resv-check" value="${r.id}" title="Select reservation"></label>
            <div class="rc-title">⏰ <b>${esc(r.time_slot)}</b> <span class="muted" style="font-size:12px">· RES-${esc(r.id)}</span></div>
            <span class="badge b-${esc(r.status)}">${esc(r.status)}</span>
          </div>
          <div class="rc-cust">
            <span class="rc-line">👤 ${esc(r.customer_name)} <span class="muted">${esc(r.phone || '')}</span></span>
            ${r.res_date ? `<span class="rc-line">📅 ${esc(r.res_date)}</span>` : ''}
            ${r.notes ? `<span class="rc-line">📝 ${esc(r.notes)}</span>` : ''}
          </div>
          <div class="rc-order">
            ${r.order_id
              ? `🔗 <a href="#" class="order-link" data-order="${r.order_id}" style="color:var(--brand);font-weight:600">Order #${r.order_id}</a>${r.order ? ` · <b>${peso(r.order.total || 0)}</b> · <span class="badge b-${esc(r.order.status)}">${esc(r.order.status)}</span>${r.order.payment_status === 'PAID' ? ' 💰' : ''}` : ''}`
              : '<span class="muted">No linked order</span>'}
          </div>
          <div class="rc-foot">
            <div class="rc-actions">
              ${r.status === 'PENDING' ? `<button class="btn ok sm" data-resv-ok="${r.id}">Confirm</button>` : ''}
              <div class="row-menu-wrap">
                <button class="btn ghost sm" data-menu-btn title="More actions" aria-haspopup="true">⋯</button>
                <div class="row-menu">
                  <button class="btn ghost sm" data-resv-view="${r.id}" title="View details">👁️ View details</button>
                  ${r.status !== 'CANCELLED' && r.status !== 'COMPLETED' ? `<button class="btn ghost sm" data-resv-edit="${r.id}" title="Edit reservation (change of mind)">✏️ Edit</button>` : ''}
                  ${r.status !== 'CANCELLED' && r.status !== 'COMPLETED' ? `<button class="btn ghost sm" data-resv-move="${r.id}">📅 Reschedule</button>` : ''}
                  ${r.status !== 'CANCELLED' ? `<button class="btn danger sm" data-resv-cancel="${r.id}">✕ Cancel</button>` : ''}
                  ${r.order && NEXT_STATUS[r.order.status] ? `<button class="btn ghost sm" data-resv-adv="${r.order_id}" data-resv-next="${NEXT_STATUS[r.order.status]}" title="Advance linked order to ${NEXT_STATUS[r.order.status]}">→ Order: ${NEXT_STATUS[r.order.status]}</button>` : ''}
                  ${r.order && r.order.payment_status !== 'PAID' && r.order.status !== 'CANCELLED' ? `<button class="btn ghost sm" data-resv-paid="${r.order_id}" title="Mark linked order as paid">💰 Order Paid</button>` : ''}
                  ${ROLE === 'ADMIN' ? `<button class="btn danger sm" data-del-resv="${r.id}" title="Permanently delete">🗑 Delete</button>` : ''}
                </div>
              </div>
            </div>
          </div>
        </div>`).join('') || '<div class="rc-empty">No reservations for this date.</div>'}
      </div>`;

    // View details handler
    main.querySelectorAll('[data-resv-view]').forEach((b) => b.addEventListener('click', async () => {
      const r = resvs.find((x) => x.id == b.dataset.resvView);
      showLoading('Loading details…');
      let reservationDetails = r;
      try {
        reservationDetails = await api(`/reservations/${r.id}`);
      } catch {
        // Fall back to basic info from list
      }
      hideLoading();

      const row = (label, value) => `<div style="display:flex;justify-content:space-between;padding:10px;background:#f8f9fa;border-radius:8px"><span style="color:#666">${label}</span><span style="font-weight:700">${value}</span></div>`;
      const ord = reservationDetails.order || null;
      const orderRow = reservationDetails.order_id ? row('Linked Order', `<span style="color:#e74c3c">#${reservationDetails.order_id}</span>${ord ? ` · <span class="badge b-${esc(ord.status)}">${esc(ord.status)}</span> · ₱${Number(ord.total || 0).toLocaleString('en-PH')} · ${esc(ord.payment_status || 'UNPAID')}` : ''}`) : '';
      const orderActions = ord && ord.status !== 'CANCELLED' && ord.status !== 'COMPLETED' ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:6px">
          ${NEXT_STATUS[ord.status] ? `<button class="btn ok sm" id="m-adv" data-next="${NEXT_STATUS[ord.status]}">→ ${NEXT_STATUS[ord.status]}</button>` : ''}
          ${ord.payment_status !== 'PAID' ? `<button class="btn sm" id="m-paid">💰 Mark Paid</button>` : ''}
          ${ord.order_type === 'delivery' ? `<button class="btn sm" id="m-rider">🛵 Rider OTW</button>` : ''}
          <button class="btn sm" id="m-disc">➖ Discount</button>
        </div>` : '';
      const notesRow = reservationDetails.notes ? row('Notes', esc(reservationDetails.notes)) : '';
      const itemsRow = renderOrderItems(reservationDetails.order_items);

      modal(`<h3>📋 Reservation Details</h3>
        <div style="display:grid;gap:10px;margin:16px 0;max-height:60vh;overflow-y:auto">
          ${row('Reference', `RES-${reservationDetails.id}`)}
          ${row('Date', esc(reservationDetails.res_date))}
          ${row('Time Slot', esc(reservationDetails.time_slot))}
          ${row('Customer', esc(reservationDetails.customer_name))}
          ${row('Phone', esc(reservationDetails.phone || '—'))}
          ${row('Status', `<span class="badge b-${esc(reservationDetails.status)}">${esc(reservationDetails.status)}</span>`)}
          ${orderRow}
          ${itemsRow}
          ${notesRow}
          ${row('Created', esc(reservationDetails.created_at || '—'))}
        </div>
        ${orderActions}
        <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Close</button></div>`);
      // Modal order actions — same endpoints as the Orders page
      const ordId = reservationDetails.order_id;
      const mAdv = document.getElementById('m-adv');
      if (mAdv) mAdv.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
        await api(`/orders/${ordId}/status`, { method: 'POST', body: { status: mAdv.dataset.next } });
        closeModal(); toast('Order advanced'); navigate('reservations');
      }));
      const mPaid = document.getElementById('m-paid');
      if (mPaid) mPaid.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
        await api(`/orders/${ordId}/payment-status`, { method: 'POST', body: { payment_status: 'PAID' } });
        closeModal(); toast('Marked as paid'); navigate('reservations');
      }));
      const mRider = document.getElementById('m-rider');
      if (mRider) mRider.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
        await api(`/orders/${ordId}/status`, { method: 'POST', body: { status: 'READY' } });
        closeModal(); toast('Rider on-the-way notification sent'); navigate('reservations');
      }));
      const mDisc = document.getElementById('m-disc');
      if (mDisc) mDisc.addEventListener('click', async () => {
        const val = prompt('Additional discount (₱):');
        if (val === null) return;
        await api(`/orders/${ordId}/discount`, { method: 'POST', body: { additional_discount: Number(val) || 0 } });
        closeModal(); toast('Discount applied'); navigate('reservations');
      });
    }));

    // Order link handler
    main.querySelectorAll('.order-link').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); navigate('orders'); }));
    main.querySelectorAll('[data-resv-ok]').forEach((b) => b.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
      await api(`/reservations/${b.dataset.resvOk}/status`, { method: 'POST', body: { status: 'CONFIRMED' } });
      toast('Reservation confirmed'); navigate('reservations');
    })));
    main.querySelectorAll('[data-resv-cancel]').forEach((b) => b.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
      if (!confirm('Cancel this reservation?')) return;
      await api(`/reservations/${b.dataset.resvCancel}/cancel`, { method: 'POST' });
      toast('Cancelled'); navigate('reservations');
    })));
    // Order actions on the linked order — same endpoints as the Orders page,
    // so notifications / payment / totals behave identically.
    main.querySelectorAll('[data-resv-adv]').forEach((b) => b.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
      await api(`/orders/${b.dataset.resvAdv}/status`, { method: 'POST', body: { status: b.dataset.resvNext } });
      toast('Order advanced'); navigate('reservations');
    })));
    main.querySelectorAll('[data-resv-paid]').forEach((b) => b.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
      await api(`/orders/${b.dataset.resvPaid}/payment-status`, { method: 'POST', body: { payment_status: 'PAID' } });
      toast('Marked as paid'); navigate('reservations');
    })));
    main.querySelectorAll('[data-resv-move]').forEach((b) => b.addEventListener('click', () => {
      const r = resvs.find((x) => x.id == b.dataset.resvMove);
      modal(`<h3>Reschedule reservation</h3>
        <div class="field"><label>Date</label><input type="date" id="mv-date" value="${esc(r.res_date)}"></div>
        <div class="field"><label>Time slot</label><input id="mv-time" value="${esc(r.time_slot)}" placeholder="e.g. 10:00 AM"></div>
        <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button>
        <button class="btn" id="mv-save">Save</button></div>`);
      document.getElementById('mv-save').addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
        await api(`/reservations/${r.id}/reschedule`, { method: 'POST', body: { res_date: document.getElementById('mv-date').value, time_slot: document.getElementById('mv-time').value } });
        closeModal(); toast('Rescheduled'); navigate('reservations');
      }));
    }));

    main.querySelectorAll('[data-resv-edit]').forEach((b) => b.addEventListener('click', () => {
      const r = resvs.find((x) => x.id == b.dataset.resvEdit);
      if (r) openReservationEditor(Number(b.dataset.resvEdit), r);
    }));

    // Restore selections after re-render
    main.querySelectorAll('.resv-check').forEach((b) => { b.checked = selected.has(Number(b.value)); });
    const checkAllBox = main.querySelector('#resv-check-all');
    if (checkAllBox) {
      const boxes = main.querySelectorAll('.resv-check');
      checkAllBox.checked = boxes.length > 0 && [...boxes].every((x) => x.checked);
      checkAllBox.indeterminate = selected.size > 0 && !checkAllBox.checked;
    }
    renderResvBulk(resvs);

    // ---- Bulk actions ----
    if (checkAllBox) checkAllBox.addEventListener('change', () => {
      main.querySelectorAll('.resv-check').forEach((b) => {
        b.checked = checkAllBox.checked;
        if (checkAllBox.checked) selected.add(Number(b.value)); else selected.delete(Number(b.value));
      });
      renderResvBulk(resvs);
    });
    main.querySelectorAll('.resv-check').forEach((b) => b.addEventListener('change', () => {
      const id = Number(b.value);
      if (b.checked) selected.add(id); else selected.delete(id);
      const ca = main.querySelector('#resv-check-all');
      const boxes = main.querySelectorAll('.resv-check');
      if (ca) {
        ca.checked = boxes.length > 0 && [...boxes].every((x) => x.checked);
        ca.indeterminate = selected.size > 0 && !ca.checked;
      }
      renderResvBulk(resvs);
    }));
    const bulkClear = main.querySelector('#resv-bulk-clear');
    if (bulkClear) bulkClear.addEventListener('click', () => {
      selected.clear();
      main.querySelectorAll('.resv-check').forEach((b) => { b.checked = false; });
      const ca = main.querySelector('#resv-check-all');
      if (ca) { ca.checked = false; ca.indeterminate = false; }
      renderResvBulk(resvs);
    });
    const bulkConfirm = main.querySelector('#resv-bulk-confirm');
    if (bulkConfirm) bulkConfirm.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
      const targets = resvs.filter((r) => selected.has(r.id) && r.status === 'PENDING');
      if (!targets.length) return toast('No selected reservations can be confirmed', true);
      if (!confirm(`Confirm ${targets.length} reservation(s)?`)) return;
      await Promise.all(targets.map((r) => api(`/reservations/${r.id}/status`, { method: 'POST', body: { status: 'CONFIRMED' } })));
      toast(`Confirmed ${targets.length} reservation(s)`); navigate('reservations');
    }));
    const bulkComplete = main.querySelector('#resv-bulk-complete');
    if (bulkComplete) bulkComplete.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
      const targets = resvs.filter((r) => selected.has(r.id) && r.status === 'CONFIRMED');
      if (!targets.length) return toast('No selected reservations can be completed', true);
      if (!confirm(`Complete ${targets.length} reservation(s)?`)) return;
      await Promise.all(targets.map((r) => api(`/reservations/${r.id}/status`, { method: 'POST', body: { status: 'COMPLETED' } })));
      toast(`Completed ${targets.length} reservation(s)`); navigate('reservations');
    }));
    const bulkCancel = main.querySelector('#resv-bulk-cancel');
    if (bulkCancel) bulkCancel.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
      const targets = resvs.filter((r) => selected.has(r.id) && r.status !== 'CANCELLED' && r.status !== 'COMPLETED');
      if (!targets.length) return toast('No selected reservations can be cancelled', true);
      if (!confirm(`Cancel ${targets.length} reservation(s)?`)) return;
      await Promise.all(targets.map((r) => api(`/reservations/${r.id}/cancel`, { method: 'POST' })));
      toast(`Cancelled ${targets.length} reservation(s)`); navigate('reservations');
    }));
    const bulkDelResv = main.querySelector('#resv-bulk-del');
    if (bulkDelResv) bulkDelResv.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
      const targets = resvs.filter((r) => selected.has(r.id));
      if (!targets.length) return toast('No selected reservations to delete', true);
      if (!confirm(`Permanently delete ${targets.length} reservation(s)? This cannot be undone.`)) return;
      await Promise.all(targets.map((r) => api(`/reservations/${r.id}`, { method: 'DELETE' })));
      toast(`Deleted ${targets.length} reservation(s)`); navigate('reservations');
    }));
    const bulkResetResv = main.querySelector('#resv-bulk-reset');
    if (bulkResetResv) bulkResetResv.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
      if (!resvs.length) return toast('No reservations to reset', true);
      if (!confirm('⚠️ This will PERMANENTLY DELETE ALL RESERVATIONS. This CANNOT be undone. Continue?')) return;
      if (!confirm('Are you absolutely sure? There is no undo for this action.')) return;
      await api('/reservations', { method: 'DELETE' });
      toast('All reservations cleared'); navigate('reservations');
    }));
    // Per-row permanent delete
    main.querySelectorAll('[data-del-resv]').forEach((b) => b.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
      if (!confirm('Permanently delete this reservation? This cannot be undone.')) return;
      await api(`/reservations/${b.dataset.delResv}`, { method: 'DELETE' });
      toast('Reservation deleted'); navigate('reservations');
    })));
  };
  main.querySelector('#resv-date').addEventListener('change', (e) => { sessionStorage.setItem('resvDate', e.target.value); navigate('reservations'); });
  // ---- Filter controls ----
  const saveF = () => {
    f.status = main.querySelector('#resv-f-status').value;
    f.slot = main.querySelector('#resv-f-slot').value;
    f.q = main.querySelector('#resv-f-q').value.trim();
    f.range = main.querySelector('#resv-f-range').value;
    f.from = main.querySelector('#resv-f-from') ? main.querySelector('#resv-f-from').value : '';
    f.to = main.querySelector('#resv-f-to') ? main.querySelector('#resv-f-to').value : '';
    f.incCancelled = main.querySelector('#resv-f-cancel').checked;
    sessionStorage.setItem('resvFStatus', f.status);
    sessionStorage.setItem('resvFSlot', f.slot);
    sessionStorage.setItem('resvFQ', f.q);
    sessionStorage.setItem('resvFRange', f.range);
    sessionStorage.setItem('resvFFrom', f.from);
    sessionStorage.setItem('resvFTo', f.to);
    sessionStorage.setItem('resvFCancel', f.incCancelled ? '1' : '0');
  };
  let debounceTimer = null;
  const applyFilters = () => { saveF(); reload().catch((err) => toast(err.message, true)); };
  const debouncedFilters = () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(applyFilters, 300); };
  main.querySelector('#resv-f-status').addEventListener('change', applyFilters);
  main.querySelector('#resv-f-slot').addEventListener('change', applyFilters);
  main.querySelector('#resv-f-q').addEventListener('input', debouncedFilters);
  main.querySelector('#resv-f-range').addEventListener('change', () => {
    main.querySelector('#resv-f-range-inputs').style.display = main.querySelector('#resv-f-range').value === 'range' ? 'inline-flex' : 'none';
    applyFilters();
  });
  main.querySelector('#resv-f-from').addEventListener('change', applyFilters);
  main.querySelector('#resv-f-to').addEventListener('change', applyFilters);
  main.querySelector('#resv-f-cancel').addEventListener('change', applyFilters);
  main.querySelector('#resv-f-clear').addEventListener('click', () => {
    ['resvFStatus', 'resvFSlot', 'resvFQ', 'resvFRange', 'resvFFrom', 'resvFTo', 'resvFCancel'].forEach((k) => sessionStorage.removeItem(k));
    navigate('reservations');
  });
  main.querySelector('#resv-new').addEventListener('click', () => {
    modal(`<h3>New Manual Reservation</h3>
      <div class="field"><label>Customer name</label><input id="nr-name"></div>
      <div class="field"><label>Phone</label><input id="nr-phone"></div>
      <div class="row2">
        <div class="field"><label>Date</label><input type="date" id="nr-date" value="${date}"></div>
        <div class="field"><label>Time slot</label><input id="nr-time" placeholder="e.g. 2:00 PM"></div>
      </div>
      <div class="field"><label>Notes</label><textarea id="nr-notes" rows="2"></textarea></div>
      <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn" id="nr-save">Create</button></div>`);
    document.getElementById('nr-save').addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
      await api('/reservations', {
        method: 'POST', body: {
          customer_name: document.getElementById('nr-name').value,
          phone: document.getElementById('nr-phone').value,
          res_date: document.getElementById('nr-date').value,
          time_slot: document.getElementById('nr-time').value,
          notes: document.getElementById('nr-notes').value,
        }
      });
      closeModal(); toast('Reservation created'); navigate('reservations');
    }));
  });
  await reload();
};

/* ================= MENU ================= */
views.menu = async (main) => {
  const [products, cats, branchData] = await Promise.all([api('/products'), api('/categories'), api('/branches')]);
  if (branchData?.branches?.length) BRANCHES = branchData.branches;
  const activeTab = sessionStorage.getItem('menuTab') || 'products';

  const renderProducts = () => {
    const filt = document.getElementById('mf-filter')?.value || 'all';
    const catId = document.getElementById('mf-category')?.value || 'all';
    const search = (document.getElementById('mf-search')?.value || '').toLowerCase().trim();
    const tbody = document.getElementById('prod-tbody');
    let filtered = products;
    if (catId !== 'all') filtered = filtered.filter((p) => p.category_id === Number(catId));
    if (filt === 'active') filtered = filtered.filter((p) => p.active && !p.unavailable);
    else if (filt === 'inactive') filtered = filtered.filter((p) => !p.active);
    else if (filt === 'unavailable') filtered = filtered.filter((p) => p.unavailable);
    if (search) filtered = filtered.filter((p) => (p.name || '').toLowerCase().includes(search) || (p.description || '').toLowerCase().includes(search));
    tbody.innerHTML = filtered.length ? filtered.map((p) => `
      <tr class="prod-row">
        <td>${imgTag(p.photo_url, p.name)}</td>
        <td><b>${esc(p.name)}</b><br><span class="muted">${esc(p.description || '')}</span></td>
        <td>${esc((cats.find((c) => c.id === p.category_id) || {}).name || '—')}</td>
        <td>${(p.variants || []).map((v) => `${esc(v.size)} ${peso(v.price)}`).join(' • ') || '<span class="muted">none</span>'}</td>
        <td>${p.unavailable ? '<span class="badge b-CANCELLED">Unavailable</span>' : (p.active ? '<span class="badge b-CONFIRMED">Available</span>' : '<span class="badge b-COMPLETED">Inactive</span>')}</td>
        <td>${branchBadges(p)}</td>
        <td><div class="row-actions">
          <button class="btn ghost sm" data-edit="${p.id}">Edit</button>
          <button class="btn ghost sm" data-variants="${p.id}">Prices</button>
          <button class="btn ghost sm" data-deact="${p.id}">${p.active ? 'Disable' : 'Enable'}</button>
        </div></td>
      </tr>`).join('') : '<tr><td colspan="7" class="muted">No products match your filters.</td></tr>';
  };

  const renderCategories = () => {
    const tbody = document.getElementById('cat-tbody');
    tbody.innerHTML = cats.length ? cats.map((c) => `
      <tr>
        <td><b>${esc(c.name)}</b></td>
        <td>${esc(String(c.sort_order ?? 0))}</td>
        <td>${products.filter((p) => p.category_id === c.id).length}</td>
        <td>${c.active ? '<span class="badge b-CONFIRMED">Active</span>' : '<span class="badge b-CANCELLED">Hidden</span>'}</td>
        <td><div class="row-actions">
          <button class="btn ghost sm" data-cat-edit="${c.id}">Rename</button>
          <button class="btn ghost sm" data-cat-toggle="${c.id}">${c.active ? 'Hide' : 'Show'}</button>
          <button class="btn danger sm" data-cat-delete="${c.id}">Delete</button>
        </div></td>
      </tr>`).join('') : '<tr><td colspan="5" class="muted">No categories.</td></tr>';
  };

  main.innerHTML = `
    <h2 class="page-title">Menu</h2>
    <div class="tabs" id="menu-tabs">
      <button class="tab-btn${activeTab === 'products' ? ' active' : ''}" data-mtab="products">🍽️ Products</button>
      <button class="tab-btn${activeTab === 'categories' ? ' active' : ''}" data-mtab="categories">🗂️ Categories</button>
    </div>
    <div class="tab-pane${activeTab === 'products' ? ' active' : ''}" data-mpane="products">
      <div class="card">
        <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap;align-items:flex-end">
          <button class="btn sm" id="prod-new">＋ Add Product</button>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-left:auto;align-items:flex-end">
            <div class="field" style="margin-bottom:0"><label>Search</label><input id="mf-search" placeholder="Name or description…" style="width:180px"></div>
            <div class="field" style="margin-bottom:0"><label>Category</label><select id="mf-category" style="width:140px"><option value="all">All Categories</option>${cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
            <div class="field" style="margin-bottom:0"><label>Status</label><select id="mf-filter" style="width:130px"><option value="all">All</option><option value="active">Available</option><option value="inactive">Inactive</option><option value="unavailable">Unavailable</option></select></div>
          </div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Photo</th><th>Product</th><th>Category</th><th>Variants (M/L)</th><th>Availability</th><th>Branches</th><th>Actions</th></tr></thead>
          <tbody id="prod-tbody"></tbody>
        </table></div>
      </div>
    </div>
    <div class="tab-pane${activeTab === 'categories' ? ' active' : ''}" data-mpane="categories">
      <div class="card">
        <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap">
          <button class="btn sm" id="cat-new">＋ Add Category</button>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Sort</th><th>Products</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody id="cat-tbody"></tbody>
        </table></div>
      </div>
    </div>`;

  renderProducts();
  renderCategories();

  // ---- Tab switching ----
  main.querySelectorAll('#menu-tabs .tab-btn').forEach((b) => b.addEventListener('click', () => {
    sessionStorage.setItem('menuTab', b.dataset.mtab);
    main.querySelectorAll('#menu-tabs .tab-btn').forEach((x) => x.classList.toggle('active', x === b));
    main.querySelectorAll('[data-mpane]').forEach((p) => p.classList.toggle('active', p.dataset.mpane === b.dataset.mtab));
  }));

  // ---- Product filter events ----
  ['mf-search', 'mf-category', 'mf-filter'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', renderProducts);
    if (el) el.addEventListener('change', renderProducts);
  });
  // ---- Product modals & actions (event delegation for tabbed tables) ----
  const productForm = (p) => {
    const m = (p?.variants || []).find((v) => v.size === 'M');
    const l = (p?.variants || []).find((v) => v.size === 'L');
    return modal(`<h3>${p ? 'Edit' : 'New'} Product</h3>
    <div class="field"><label>Name</label><input id="pf-name" value="${esc(p?.name || '')}"></div>
    <div class="field"><label>Category</label><select id="pf-cat">${cats.map((c) => `<option value="${c.id}" ${p?.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Description</label><input id="pf-desc" value="${esc(p?.description || '')}"></div>
    <div class="row2">
      <div class="field"><label>M price (₱)</label><input type="number" id="pf-m" min="0" value="${m?.price ?? ''}"></div>
      <div class="field"><label>L price (₱)</label><input type="number" id="pf-l" min="0" value="${l?.price ?? ''}"></div>
    </div>
    ${photoField('pf-photo', p?.photo_url)}
    <div class="field"><label>Mark unavailable?</label><select id="pf-un"><option value="0">No</option><option value="1" ${p?.unavailable ? 'selected' : ''}>Yes</option></select></div>
    <div class="field"><label>Available at branches</label>${branchChecks('pf-br', p?.branches || [])}</div>
    <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button>
    <button class="btn" id="pf-save">Save</button></div>`);
  };
  const bindProductSave = (p) => {
    document.getElementById('pf-save').addEventListener('click', (e) => withBtn(e.currentTarget, () => saveProduct(p)));
  };
  const openProductForm = (p) => {
    productForm(p);
    bindPhotoField('pf-photo');
    bindProductSave(p);
    window.__modalRebind = () => {
      bindPhotoField('pf-photo');
      bindProductSave(p);
    };
  };
  const saveProduct = async (p) => {
    try {
      // Upload the cropped photo (if any) first — Save is the single upload step.
      const photo_url = await flushPendingPhoto('pf-photo');
      // A product needs at least one variant price — unpriced items cannot be
      // ordered (server pricing throws "Invalid product or size").
      const mPrice = Number(document.getElementById('pf-m').value);
      const lPrice = Number(document.getElementById('pf-l').value);
      const variants = [];
      if (mPrice > 0) variants.push({ size: 'M', price: Math.round(mPrice) });
      if (lPrice > 0) variants.push({ size: 'L', price: Math.round(lPrice) });
      if (variants.length === 0) { toast('Set at least one price (M or L) so customers can order this item.', true); return; }
      const body = {
        name: document.getElementById('pf-name').value,
        category_id: Number(document.getElementById('pf-cat').value),
        description: document.getElementById('pf-desc').value,
        photo_url: photo_url || null,
        unavailable: Number(document.getElementById('pf-un').value),
        branches: branchValues('pf-br'),
      };
      if (p) {
        await api(`/products/${p.id}`, { method: 'PUT', body });
        await api(`/products/${p.id}/variants`, { method: 'PUT', body: { variants } });
      } else {
        await api('/products', { method: 'POST', body: { ...body, variants } });
      }
      closeModal(); toast('Saved'); navigate('menu');
    } catch (err) { toast(err.message, true); }
  };
  main.querySelector('#prod-new').addEventListener('click', () => openProductForm(null));
  main.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-edit]');
    if (btn) openProductForm(products.find((x) => x.id == btn.dataset.edit));
  });
  main.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-variants]');
    if (btn) {
      const p = products.find((x) => x.id == btn.dataset.variants);
      const m = p.variants.find((v) => v.size === 'M'), l = p.variants.find((v) => v.size === 'L');
      modal(`<h3>M/L Prices — ${esc(p.name)}</h3>
        <div class="row2">
          <div class="field"><label>M price (₱)</label><input type="number" id="vp-m" value="${m?.price ?? ''}"></div>
          <div class="field"><label>L price (₱)</label><input type="number" id="vp-l" value="${l?.price ?? ''}"></div>
        </div>
        <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button>
        <button class="btn" id="vp-save">Save</button></div>`);
      document.getElementById('vp-save').addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
        // Blank fields are skipped — saving them as ₱0 would make the item free.
        const mPrice = Number(document.getElementById('vp-m').value);
        const lPrice = Number(document.getElementById('vp-l').value);
        const variants = [];
        if (mPrice > 0) variants.push({ size: 'M', price: Math.round(mPrice) });
        if (lPrice > 0) variants.push({ size: 'L', price: Math.round(lPrice) });
        if (variants.length === 0) { toast('Set at least one price (M or L).', true); return; }
        await api(`/products/${p.id}/variants`, { method: 'PUT', body: { variants } });
        closeModal(); toast('Prices updated'); navigate('menu');
      }));
    }
  });
  main.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-deact]');
    if (btn) {
      const p = products.find((x) => x.id == btn.dataset.deact);
      withBtn(btn, async () => {
        await api(`/products/${p.id}`, { method: 'PUT', body: { active: p.active ? 0 : 1 } });
        toast(p.active ? 'Product disabled' : 'Product enabled'); navigate('menu');
      });
    }
  });

  // ---- Category modals & actions ----
  const openCategoryForm = (c) => {
    modal(`<h3>${c ? 'Edit Category' : 'New Category'}</h3>
      <div class="field"><label>Name</label><input id="cn-name" value="${esc(c?.name || '')}"></div>
      <div class="field"><label>Sort Order</label><input type="number" id="cn-sort" value="${c?.sort_order ?? 0}"></div>
      <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" id="cn-save">Save</button></div>`);
    document.getElementById('cn-save').addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
      const name = document.getElementById('cn-name').value.trim();
      if (!name) { toast('Category name is required.', true); return; }
      const sort_order = Number(document.getElementById('cn-sort').value) || 0;
      if (c) await api(`/categories/${c.id}`, { method: 'PUT', body: { name, sort_order } });
      else await api('/categories', { method: 'POST', body: { name, sort_order } });
      closeModal(); toast(c ? 'Category updated' : 'Category added'); navigate('menu');
    }));
  };
  main.querySelector('#cat-new').addEventListener('click', () => openCategoryForm(null));
  main.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cat-edit]');
    if (btn) openCategoryForm(cats.find((x) => x.id == btn.dataset.catEdit));
  });
  main.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cat-toggle]');
    if (btn) {
      const c = cats.find((x) => x.id == btn.dataset.catToggle);
      withBtn(btn, async () => {
        await api(`/categories/${c.id}`, { method: 'PUT', body: { active: c.active ? 0 : 1 } });
        toast(c.active ? 'Category hidden from customers' : 'Category shown'); navigate('menu');
      });
    }
  });
  main.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cat-delete]');
    if (btn) {
      const c = cats.find((x) => x.id == btn.dataset.catDelete);
      const prodCount = products.filter((p) => p.category_id === c.id).length;
      if (!confirm(`Delete category "${c.name}"? ${prodCount > 0 ? `Warning: ${prodCount} product(s) in this category will become uncategorized.` : ''}`)) return;
      withBtn(btn, async () => {
        await api(`/categories/${c.id}`, { method: 'DELETE' });
        toast('Category deleted'); navigate('menu');
      });
    }
  });
};

/* ================= FOOD PACKS ================= */
views.foodpacks = async (main) => {
  const packs = await api('/food-packs');
  main.innerHTML = `
    <h2 class="page-title">Food Packs</h2>
    <div class="card">
      <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap">
        <button class="btn sm" id="fp-new">＋ Add Food Pack</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Photo</th><th>Name</th><th>Price</th><th>Serves</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
        ${packs.map((fp) => `
          <tr>
            <td>${imgTag(fp.photo_url, fp.name)}</td>
            <td><b>${esc(fp.name)}</b><br><span class="muted">${esc(fp.description || '')}</span></td>
            <td>${peso(fp.price)}</td>
            <td>${esc(fp.serves || '—')}</td>
            <td>${fp.active ? '<span class="badge b-CONFIRMED">Available</span>' : '<span class="badge b-COMPLETED">Inactive</span>'}</td>
            <td><div class="row-actions">
              <button class="btn ghost sm" data-fp-edit="${fp.id}">Edit</button>
              <button class="btn ghost sm" data-fp-toggle="${fp.id}">${fp.active ? 'Disable' : 'Enable'}</button>
            </div></td>
          </tr>`).join('') || '<tr><td colspan="6" class="muted">No food packs yet.</td></tr>'}
        </tbody></table></div>
      <p class="muted" style="margin-top:10px">Food packs are simple fixed-price bundles. Customers order them as-is from Messenger — no dish customization.</p>
    </div>`;

  const packForm = (fp) => modal(`<h3>${fp ? 'Edit' : 'New'} Food Pack</h3>
    <div class="field"><label>Name</label><input id="fp-name" value="${esc(fp?.name || '')}"></div>
    <div class="row2">
      <div class="field"><label>Price (₱)</label><input type="number" id="fp-price" value="${fp?.price ?? ''}"></div>
      <div class="field"><label>Serves (optional)</label><input id="fp-serves" value="${esc(fp?.serves || '')}" placeholder="e.g. 4-5 pax"></div>
    </div>
    <div class="field"><label>Description</label><input id="fp-desc" value="${esc(fp?.description || '')}"></div>
    ${photoField('fp-photo', fp?.photo_url)}
    <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button>
    <button class="btn" id="fp-save">Save</button></div>`);
  const savePack = async (fp) => {
    const body = {
      name: document.getElementById('fp-name').value.trim(),
      price: Number(document.getElementById('fp-price').value),
      serves: document.getElementById('fp-serves').value.trim() || null,
      description: document.getElementById('fp-desc').value.trim() || null,
    };
    if (!body.name || !(body.price > 0)) { toast('Name and a price above ₱0 are required.', true); return; }
    // Upload the cropped photo (if any) first — Save is the single upload step.
    body.photo_url = (await flushPendingPhoto('fp-photo')) || null;
    if (fp) await api(`/food-packs/${fp.id}`, { method: 'PUT', body });
    else await api('/food-packs', { method: 'POST', body });
    closeModal(); toast('Food pack saved'); navigate('foodpacks');
  };
  // Central open helper: binds the photo field AND the Save button, and records
  // a rebind for when the image-library picker replaces the modal HTML (that
  // swap destroys the Save listener — without this the Save button stops working).
  const openPackForm = (fp) => {
    packForm(fp);
    bindPhotoField('fp-photo');
    document.getElementById('fp-save').addEventListener('click', (e) => withBtn(e.currentTarget, () => savePack(fp)));
    window.__modalRebind = () => {
      bindPhotoField('fp-photo');
      document.getElementById('fp-save').addEventListener('click', (e) => withBtn(e.currentTarget, () => savePack(fp)));
    };
  };
  main.querySelector('#fp-new').addEventListener('click', () => openPackForm(null));
  main.querySelectorAll('[data-fp-edit]').forEach((b) => b.addEventListener('click', () => {
    openPackForm(packs.find((x) => x.id == b.dataset.fpEdit));
  }));
  main.querySelectorAll('[data-fp-toggle]').forEach((b) => b.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
    const fp = packs.find((x) => x.id == b.dataset.fpToggle);
    await api(`/food-packs/${fp.id}`, { method: 'PUT', body: { active: fp.active ? 0 : 1 } });
    toast(fp.active ? 'Food pack disabled' : 'Food pack enabled'); navigate('foodpacks');
  })));
};

/* ================= PACKAGES ================= */
views.packages = async (main) => {
  const [packages, products, cats, branchData] = await Promise.all([api('/packages'), api('/products'), api('/categories'), api('/branches')]);
  if (branchData?.branches?.length) BRANCHES = branchData.branches;
  main.innerHTML = `
    <h2 class="page-title">Packages</h2>
    <div class="card"><button class="btn sm" id="pkg-new">＋ Add Package</button></div>
    ${packages.map((p) => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <div style="display:flex;align-items:center;gap:12px">
            ${imgTag(p.photo_url, p.name)}
            <div><b>${esc(p.name)}</b> — ${p.discount > 0 ? `<s class="muted">${peso(p.base_price)}</s> ${peso(p.base_price - p.discount)} <span class="badge b-CONFIRMED">Save ${peso(p.discount)}</span>` : peso(p.base_price)}, choose ${p.selections} dishes
            ${p.is_fixed ? ' <span class="badge b-COMPLETED">fixed</span>' : ''}
            ${p.is_custom ? ' <span class="badge b-CONFIRMED">custom</span>' : ''}
            ${p.active ? '' : ' <span class="badge b-CANCELLED">inactive</span>'}
            <div style="margin-top:4px">${branchBadges(p)}</div></div>
          </div>
          <div class="row-actions">
            <button class="btn ghost sm" data-pkg-edit="${p.id}">Edit</button>
            <button class="btn ghost sm" data-pkg-toggle="${p.id}">${p.active ? 'Disable' : 'Enable'}</button>
          </div>
        </div>
        <div style="margin-top:10px" class="muted">
          ${(p.slots || []).map((s) => `Slot ${s.slot_number}: ${s.options.map((o) => esc(o.product_name) + ((o.upgrade_price || 0) ? ` (+${o.upgrade_price})` : '') + (o.is_default ? ' ★' : '')).join(', ') || 'empty'}`).join('<br>')}
        </div>
      </div>`).join('')}`;

  // ---- slot rows helpers ----
  const slotRowsOf = (p, count) => Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const s = (p.slots || []).find((x) => x.slot_number === n);
    const def = (s?.options || []).find((o) => o.is_default);
    return { n, default_product_id: def ? def.product_id : null, options: (s?.options || []).map((o) => ({ product_id: o.product_id, upgrade_price: o.upgrade_price || 0, size_upgrade_price: o.size_upgrade_price || 0 })) };
  });
  // Manual "upgrade ₱" / "L +₱" inputs were removed — 0 means the server
  // auto-prices: dish premium = menu-price diff vs the slot's default dish,
  // Large = L−M variant diff. Any pre-set values are preserved in data attrs.
  const optRowHtml = (o) => `<div style="display:flex;gap:6px;margin-bottom:6px;align-items:center" data-up="${Number(o.upgrade_price) || 0}" data-lup="${Number(o.size_upgrade_price) || 0}">
      <select style="flex:1" class="opt-prod">${products.map((x) => `<option value="${x.id}" ${x.id === o.product_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      <button class="btn danger sm" onclick="this.closest('div').remove()">✕</button>
    </div>`;
  /** Full package editor: profile + photo + fixed flag + all slots, saved together. */
  function openPackageEditor(p, draft = null) {
    const info = draft?.info || { name: p.name, description: p.description || '', base_price: p.base_price, discount: p.discount || 0, selections: p.selections, photo_url: p.photo_url || '', is_fixed: !!p.is_fixed, branches: p.branches || [] };
    const slots = draft?.slots || slotRowsOf(p, info.selections);
    // Base price is derived: sum of each slot's default dish price (cheapest variant).
    const minPrice = (pid) => {
      const prod = products.find((x) => x.id == pid);
      const vs = (prod?.variants || []).map((v) => Number(v.price)).filter((n) => !isNaN(n));
      return vs.length ? Math.min(...vs) : 0;
    };
    const computeBase = (slotList) =>
      p.is_custom ? 0 : slotList.reduce((sum, s) => sum + minPrice(s.default_product_id || (s.options[0] && s.options[0].product_id)), 0);
    const render = () => modal(`<h3>Edit Package — ${esc(p.name)}</h3>
      <div class="field"><label>Name</label><input id="pn-name" value="${esc(info.name)}"></div>
      <div class="field"><label>Description</label><input id="pn-desc" value="${esc(info.description)}"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
        ${p.is_custom
        ? '<div class="field"><label>Base price (₱) — custom package</label><input type="number" id="pn-price" value="' + info.base_price + '"></div>'
        : '<div class="field"><label>Base price (auto: sum of dishes)</label><input id="pn-price" readonly style="background:#f0f1f3" value="' + computeBase(slots) + '" title="Derived from the pre-selected dish in each slot — not editable"></div>'}
        <div class="field"><label>Additional discount (₱) — applied on top of the base price</label><input type="number" id="pn-disc" value="${info.discount || 0}" min="0"></div>
        <div class="field"><label>Selections (slots)</label><input type="number" id="pn-sel" value="${info.selections}" min="1" max="10"></div>
      </div>
      ${p.is_custom ? '' : '<p class="muted" id="pn-disc-note">Discounts only apply to packages worth ₱3,000 or more (sum of dishes).</p>'}
      ${photoField('pn-photo', info.photo_url)}
      <div class="field"><label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--ink)">
        <input type="checkbox" id="pn-fixed" style="width:auto" ${info.is_fixed ? 'checked' : ''}> Fixed package (dishes pre-set — customers cannot change them)</label></div>
      <div class="field"><label>Available at branches</label>${branchChecks('pn-br', info.branches || [])}</div>
      ${p.is_custom ? '<p class="muted">Custom package: every slot accepts <b>all menu dishes</b> automatically. Pick the dishes customers can choose (★ pre-selects the default).</p>' : ''}
      <h3 style="margin:6px 0 4px">Slots &amp; dish options</h3>
      <p class="muted" style="margin:0 0 10px">Pricing is automatic: a dish pricier than the slot's default adds the menu-price difference, and size L adds the L−M variant difference.</p>
      ${slots.map((s) => `
        <div class="card" style="box-shadow:none;border:1px solid #eee;padding:12px;margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
            <b>Slot ${s.n}</b>
            <select style="max-width:55%" class="slot-def" data-n="${s.n}" title="Pre-selected dish (★). Used as-is for fixed packages.">
              <option value="">Default dish (first option)</option>
              ${products.map((x) => `<option value="${x.id}" ${x.id === s.default_product_id ? 'selected' : ''}>★ ${esc(x.name)}</option>`).join('')}
            </select>
          </div>
          <div style="display:flex;gap:6px;margin:8px 0;align-items:center;flex-wrap:wrap">
            <select class="slot-cat" data-n="${s.n}" style="flex:1;min-width:150px" title="Bulk-add every dish from a category">
              <option value="">Add whole category…</option>
              ${cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
            </select>
            <button type="button" class="btn ghost sm" onclick="addCategoryToSlot(${s.n})">＋ Add all</button>
          </div>
          <div id="slot-opts-${s.n}" style="margin-top:0">${s.options.map((o) => optRowHtml(o)).join('')}</div>
          <button type="button" class="btn ghost sm" onclick="addOptRow(${s.n})">＋ Add dish option</button>
        </div>`).join('')}
      <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" id="pn-save">Save Package</button></div>`);
    render();
    bindPhotoField('pn-photo');
    // Swapping a dish in a slot resets any hidden manual surcharges so the new
    // dish is auto-priced from the menu instead of inheriting the old values.
    document.getElementById('modal').addEventListener('change', (e) => {
      const t = e.target;
      if (t.classList && t.classList.contains('opt-prod')) {
        const row = t.closest('div');
        if (row) { row.dataset.up = '0'; row.dataset.lup = '0'; }
      }
    });
    const optRowElement = (pid) => {
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;align-items:center';
      div.setAttribute('data-up', '0');
      div.setAttribute('data-lup', '0');
      div.innerHTML = `<select style="flex:1" class="opt-prod">${products.map((x) => `<option value="${x.id}" ${x.id === pid ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <button class="btn danger sm" onclick="this.closest('div').remove()">✕</button>`;
      return div;
    };
    window.addOptRow = (n) => {
      document.getElementById('slot-opts-' + n).appendChild(optRowElement());
    };
    // Fast editing: append every active dish of a category to a slot in one click.
    // Dishes already in the slot (and inactive ones) are skipped.
    window.addCategoryToSlot = (n) => {
      const sel = document.querySelector(`#modal .slot-cat[data-n="${n}"]`);
      const catId = sel ? Number(sel.value) : 0;
      if (!catId) { toast('Choose a category first.', true); return; }
      const container = document.getElementById('slot-opts-' + n);
      const existing = new Set(Array.from(container.querySelectorAll('.opt-prod')).map((s) => Number(s.value)));
      let added = 0, skipped = 0;
      for (const prod of products) {
        if (Number(prod.category_id) !== catId) continue;
        if (!prod.active || existing.has(Number(prod.id))) { skipped++; continue; }
        container.appendChild(optRowElement(Number(prod.id)));
        added++;
      }
      if (added) toast(`Added ${added} dish(es) to Slot ${n}${skipped ? ` — ${skipped} skipped (already in slot or inactive)` : ''}`);
      else toast('Nothing to add — every dish in that category is already in the slot (or inactive).', true);
    };
    const readInfo = () => ({
      name: document.getElementById('pn-name').value,
      description: document.getElementById('pn-desc').value,
      base_price: Number(document.getElementById('pn-price').value) || 0,
      discount: Math.max(0, Number(document.getElementById('pn-disc').value) || 0),
      selections: Number(document.getElementById('pn-sel').value),
      photo_url: document.getElementById('pn-photo').value,
      is_fixed: document.getElementById('pn-fixed').checked ? 1 : 0,
      branches: branchValues('pn-br'),
    });
    const readSlots = (count) => {
      const modalEl = document.getElementById('modal');
      return Array.from({ length: count }, (_, i) => {
        const n = i + 1;
        const opts = Array.from(modalEl.querySelectorAll(`#slot-opts-${n} > div`)).map((row) => ({
          product_id: Number(row.querySelector('.opt-prod').value),
          upgrade_price: Number(row.dataset.up) || 0,
          size_upgrade_price: Number(row.dataset.lup) || 0,
        }));
        const defSel = modalEl.querySelector(`.slot-def[data-n="${n}"]`);
        return { n, default_product_id: defSel && defSel.value ? Number(defSel.value) : null, options: opts };
      });
    };
    // Changing the selections count rebuilds the slot section, keeping entered values.
    document.getElementById('pn-sel').addEventListener('change', () => {
      const count = Math.max(1, Math.min(10, Number(document.getElementById('pn-sel').value) || 1));
      document.getElementById('pn-sel').value = count;
      openPackageEditor(p, { info: readInfo(), slots: readSlots(info.selections) });
    });
    // Live-update the (read-only) base price whenever a slot's default dish changes.
    if (!p.is_custom) {
      const refreshBase = () => {
        const el = document.getElementById('pn-price');
        const base = computeBase(readSlots(info.selections));
        if (el) el.value = base;
        // Discount rule: sum of items below ₱3000 → discount forced to 0.
        const disc = document.getElementById('pn-disc');
        const note = document.getElementById('pn-disc-note');
        if (disc) {
          if (base < 3000) { disc.value = 0; disc.disabled = true; }
          else disc.disabled = false;
        }
        if (note) note.style.display = base < 3000 ? '' : 'none';
      };
      document.getElementById('modal').addEventListener('change', (e) => {
        const t = e.target;
        if (t.classList && (t.classList.contains('slot-def') || t.classList.contains('opt-prod'))) refreshBase();
      });
      refreshBase();
    }
    const onPnSave = (e) => withBtn(e.currentTarget, async () => {
      // Upload the cropped photo (if any) first so readInfo() picks up its URL.
      await flushPendingPhoto('pn-photo');
      const infoBody = readInfo();
      // Recompute base price from the current slots right before saving.
      if (!p.is_custom) infoBody.base_price = computeBase(readSlots(infoBody.selections));
      if (!infoBody.name.trim()) throw new Error('Package name is required.');
      const slotsPayload = readSlots(infoBody.selections).map((s) => {
        const upgrade_prices = {}, size_upgrade_prices = {};
        s.options.forEach((o) => { upgrade_prices[o.product_id] = o.upgrade_price; size_upgrade_prices[o.product_id] = o.size_upgrade_price; });
        if (s.default_product_id && !s.options.some((o) => o.product_id === s.default_product_id)) {
          throw new Error(`Slot ${s.n}: the default dish must be one of the slot's dish options.`);
        }
        if (!p.is_custom && s.options.length === 0) {
          throw new Error(`Slot ${s.n}: add at least one dish option (or mark the package as custom).`);
        }
        return { slot_number: s.n, product_ids: s.options.map((o) => o.product_id), upgrade_prices, size_upgrade_prices, default_product_id: s.default_product_id ?? undefined };
      });
      await api(`/packages/${p.id}`, { method: 'PUT', body: infoBody });
      await api(`/packages/${p.id}/slots`, { method: 'PUT', body: { slots: slotsPayload } });
      closeModal(); toast('Package saved'); navigate('packages');
    });
    document.getElementById('pn-save').addEventListener('click', onPnSave);
    // The image-library picker replaces the modal HTML — rebind photo + Save after restore.
    window.__modalRebind = () => {
      bindPhotoField('pn-photo');
      document.getElementById('pn-save').addEventListener('click', onPnSave);
    };
  }

  main.querySelector('#pkg-new').addEventListener('click', () => {
    modal(`<h3>New Package</h3>
      <div class="field"><label>Name</label><input id="np-name"></div>
      <div class="field"><label>Description</label><input id="np-desc"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="field"><label>Additional discount (₱)</label><input type="number" id="np-disc" value="0" min="0"></div>
        <div class="field"><label>Selections (slots)</label><input type="number" id="np-sel" value="4" min="1" max="10"></div>
      </div>
      <p class="muted">Base price is computed automatically from the dishes you add (sum of each slot's pre-selected dish).</p>
      ${photoField('np-photo', null)}
      <div class="field"><label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--ink)">
        <input type="checkbox" id="np-fixed" style="width:auto"> Fixed package (dishes pre-set — customers cannot change them)</label></div>
      <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" id="np-save">Create &amp; Add Dishes</button></div>`);
    const bindNpSave = () => {
      document.getElementById('np-save').addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
        const name = document.getElementById('np-name').value.trim();
        if (!name) throw new Error('Package name is required.');
        // Upload the cropped photo (if any) first — Save is the single upload step.
        const photo_url = await flushPendingPhoto('np-photo');
        const created = await api('/packages', {
          method: 'POST', body: {
            name,
            description: document.getElementById('np-desc').value,
            base_price: 0, // set automatically from the slot dishes
            discount: Math.max(0, Number(document.getElementById('np-disc').value) || 0),
            selections: Number(document.getElementById('np-sel').value),
            photo_url: photo_url || null,
            is_fixed: document.getElementById('np-fixed').checked ? 1 : 0,
          }
        });
        toast('Package created — now add its dishes');
        const fresh = await api('/packages');
        const p = fresh.find((x) => x.id === created.id);
        if (p) openPackageEditor(p); else navigate('packages');
      }));
    };
    bindPhotoField('np-photo');
    bindNpSave();
    window.__modalRebind = () => { bindPhotoField('np-photo'); bindNpSave(); };
  });
  main.querySelectorAll('[data-pkg-edit]').forEach((b) => b.addEventListener('click', () => {
    const p = packages.find((x) => x.id == b.dataset.pkgEdit);
    openPackageEditor(p);
  }));
  main.querySelectorAll('[data-pkg-toggle]').forEach((b) => b.addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
    const p = packages.find((x) => x.id == b.dataset.pkgToggle);
    await api(`/packages/${p.id}`, { method: 'PUT', body: { active: p.active ? 0 : 1 } });
    navigate('packages');
  })));
};

/* ================= CUSTOMERS (members) ================= */
views.customers = async (main) => {
  const customers = await api('/customers');
  main.innerHTML = `
    <h2 class="page-title">Customers</h2>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Messenger ID</th><th>Phone</th><th>Address</th><th>Orders</th><th>Total Spent</th><th>Actions</th></tr></thead>
      <tbody>${customers.map((c) => `
        <tr>
          <td><b>${esc(c.name || 'Unnamed')}</b></td>
          <td class="muted">${esc(c.psid)}</td>
          <td>${esc(c.phone || '—')}</td>
          <td>${esc(c.address || '—')}</td>
          <td>${c.total_orders}</td>
          <td>${peso(c.total_spent)}</td>
          <td><div class="row-actions">
            <button class="btn ghost sm" data-c-edit="${c.id}">Edit</button>
            <button class="btn ghost sm" data-c-history="${c.id}">History</button>
            <button class="btn danger sm" data-c-del="${c.id}">Delete</button>
          </div></td>
        </tr>`).join('') || '<tr><td colspan="7" class="muted">No customers yet.</td></tr>'}
      </tbody></table></div></div>`;

  main.querySelectorAll('[data-c-edit]').forEach((b) => b.addEventListener('click', () => {
    const c = customers.find((x) => x.id == b.dataset.cEdit);
    modal(`<h3>Edit Member</h3>
      <div class="field"><label>Name</label><input id="ce-name" value="${esc(c.name || '')}"></div>
      <div class="row2">
        <div class="field"><label>Phone</label><input id="ce-phone" value="${esc(c.phone || '')}"></div>
        <div class="field"><label>Messenger ID</label><input value="${esc(c.psid)}" disabled></div>
      </div>
      <div class="field"><label>Address</label><input id="ce-address" value="${esc(c.address || '')}"></div>
      <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn" id="ce-save">Save</button></div>`);
    document.getElementById('ce-save').addEventListener('click', async () => {
      try {
        await api(`/customers/${c.id}`, {
          method: 'PUT', body: {
            name: document.getElementById('ce-name').value,
            phone: document.getElementById('ce-phone').value,
            address: document.getElementById('ce-address').value,
          }
        });
        closeModal(); toast('Member updated'); navigate('customers');
      } catch (err) { toast(err.message, true); }
    });
  }));

  main.querySelectorAll('[data-c-history]').forEach((b) => b.addEventListener('click', async () => {
    const c = customers.find((x) => x.id == b.dataset.cHistory);
    modal(`<h3>Order History — ${esc(c.name || 'Unnamed')}</h3>
      <div id="ch-list" class="muted">Loading…</div>
      <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Close</button></div>`);
    try {
      const orders = await api(`/customers/${c.id}/orders`);
      document.getElementById('ch-list').innerHTML = orders.map((o) => `
        <div class="slot-row"><span><b>${esc(o.order_number)}</b> — ${esc(o.order_type)}<br>
          <span class="muted">${esc((o.created_at || '').slice(0, 16))}${o.fulfillment_date ? ' · ' + esc(o.fulfillment_date) + ' ' + esc(o.time_slot || '') : ''}</span></span>
          <span><span class="badge b-${esc(o.status)}">${esc(o.status)}</span> ${peso(o.total)}</span>
        </div>`).join('') || '<p class="muted">No orders yet.</p>';
    } catch (err) { document.getElementById('ch-list').textContent = err.message; }
  }));

  main.querySelectorAll('[data-c-del]').forEach((b) => b.addEventListener('click', async () => {
    const c = customers.find((x) => x.id == b.dataset.cDel);
    if (!confirm(`Delete member "${c.name || c.psid}"? This cannot be undone.`)) return;
    try {
      await api(`/customers/${c.id}`, { method: 'DELETE' });
      toast('Member deleted'); navigate('customers');
    } catch (err) { toast(err.message, true); }
  }));
};

/* ================= DELIVERY ================= */
views.delivery = async (main) => {
  const areas = await api('/delivery-areas');
  main.innerHTML = `
    <h2 class="page-title">Delivery Areas</h2>
    <div class="card">
      <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
        <input id="da-name" placeholder="Area name" style="width:200px">
        <input id="da-fee" type="number" placeholder="Fee ₱" style="width:110px">
        <button class="btn sm" id="da-add">Add Area</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Area</th><th>Fee</th><th>Active</th><th>Actions</th></tr></thead>
        <tbody>${areas.map((a) => `
          <tr>
            <td>${esc(a.name)}</td>
            <td>${peso(a.fee)}</td>
            <td>${a.active ? '✅' : '❌'}</td>
            <td><div class="row-actions">
              <button class="btn ghost sm" data-da-edit="${a.id}">Edit</button>
              <button class="btn ghost sm" data-da-toggle="${a.id}">${a.active ? 'Disable' : 'Enable'}</button>
              <button class="btn danger sm" data-da-del="${a.id}">Delete</button>
            </div></td>
          </tr>`).join('') || '<tr><td colspan="4" class="muted">No delivery areas.</td></tr>'}
        </tbody></table></div>
    </div>`;
  main.querySelector('#da-add').addEventListener('click', async () => {
    const name = document.getElementById('da-name').value, fee = Number(document.getElementById('da-fee').value);
    if (!name) return toast('Name required', true);
    await api('/delivery-areas', { method: 'POST', body: { name, fee } });
    toast('Area added'); navigate('delivery');
  });
  main.querySelectorAll('[data-da-toggle]').forEach((b) => b.addEventListener('click', async () => {
    const a = areas.find((x) => x.id == b.dataset.daToggle);
    await api(`/delivery-areas/${a.id}`, { method: 'PUT', body: { active: a.active ? 0 : 1 } });
    navigate('delivery');
  }));
  main.querySelectorAll('[data-da-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this area?')) return;
    await api(`/delivery-areas/${b.dataset.daDel}`, { method: 'DELETE' });
    navigate('delivery');
  }));
  main.querySelectorAll('[data-da-edit]').forEach((b) => b.addEventListener('click', () => {
    const a = areas.find((x) => x.id == b.dataset.daEdit);
    modal(`<h3>Edit Delivery Area</h3>
      <div class="field"><label>Name</label><input id="de-name" value="${esc(a.name)}"></div>
      <div class="field"><label>Fee (₱)</label><input type="number" id="de-fee" value="${a.fee}"></div>
      <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" id="de-save">Save</button></div>`);
    document.getElementById('de-save').addEventListener('click', async () => {
      await api(`/delivery-areas/${a.id}`, { method: 'PUT', body: { name: document.getElementById('de-name').value, fee: Number(document.getElementById('de-fee').value) } });
      closeModal(); toast('Saved'); navigate('delivery');
    });
  }));
};

/* ================= PUSH NOTIFICATIONS & SOUND ================= */
// Backed by /api/admin/push/* + /admin/sw.js. The service worker shows the OS
// notification and forwards the payload to this page (postMessage 'push-order'),
// where the chime plays and the order is read aloud (while the page is open).
const PUSH_SOUND_KEY = 'push_sound';   // '0' = off, missing/'1' = on (default on)
const PUSH_VOICE_KEY = 'push_voice';   // '0' = off, missing/'1' = on (default on)
let pushReg = null;
let audioCtx = null;

function pushSoundOn() { return localStorage.getItem(PUSH_SOUND_KEY) !== '0'; }
function pushVoiceOn() { return localStorage.getItem(PUSH_VOICE_KEY) !== '0'; }

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Two-tone chime (WebAudio). Requires a prior user gesture to unlock audio. */
function playChime() {
  if (!pushSoundOn()) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = audioCtx || new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime;
    [[880, 0], [1174.7, 0.18]].forEach(([freq, at]) => {   // A5 → D6
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.5);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.55);
    });
  } catch (e) { console.warn('[push] chime failed', e); }
}

/** Read the order aloud (emojis stripped, ₱ spoken as "pesos"). */
function speakOrder(text) {
  if (!pushVoiceOn() || !('speechSynthesis' in window)) return;
  try {
    const clean = String(text || '')
      .replace(/₱/g, ' pesos ')
      .replace(/[^\p{L}\p{N}\s.,!?:;'%-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return;
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(clean));
  } catch (e) { console.warn('[push] voice failed', e); }
}

async function ensurePushSW() {
  if (!('serviceWorker' in navigator)) return null;
  if (pushReg) return pushReg;
  try {
    pushReg = await navigator.serviceWorker.register('/admin/sw.js');
    return pushReg;
  } catch (e) { console.warn('[push] service worker registration failed', e); return null; }
}
/** Ask permission, subscribe via the VAPID key, store it server-side. */
async function subscribePush() {
  const reg = await ensurePushSW();
  if (!reg) throw new Error('Service worker unavailable in this browser');
  const { publicKey } = await api('/push/vapid-public-key');
  if (!publicKey) throw new Error('Server push not configured (VAPID keys missing on the server)');
  if (!('Notification' in window)) throw new Error('Notifications not supported here');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notification permission ' + perm);
  const existing = await reg.pushManager.getSubscription().catch(() => null);
  const sub = existing || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  const j = sub.toJSON();
  await api('/push/subscribe', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys } });
  localStorage.setItem('push_vapid_key', publicKey);
  return sub;
}

/** Unsubscribe this browser and drop it server-side. */
async function unsubscribePush() {
  const reg = await ensurePushSW();
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription().catch(() => null);
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await api('/push/unsubscribe?endpoint=' + encodeURIComponent(endpoint), { method: 'POST' }).catch(() => {});
}

/** SETUP.md §6c: if the server VAPID keys changed, re-subscribe automatically. */
async function autoResubscribeIfKeyChanged() {
  const reg = await ensurePushSW();
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription().catch(() => null);
  if (!sub) return;
  const { publicKey } = await api('/push/vapid-public-key');
  const savedKey = localStorage.getItem('push_vapid_key');
  if (!publicKey || (savedKey && savedKey === publicKey)) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  api('/push/unsubscribe?endpoint=' + encodeURIComponent(endpoint), { method: 'POST' }).catch(() => {});
  await subscribePush();
  toast('Push keys changed — this device was re-subscribed');
}

/** Auto-subscribe to push notifications on page load if permission is granted. */
async function autoSubscribePush() {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    const reg = await ensurePushSW();
    if (!reg) return;
    const { publicKey } = await api('/push/vapid-public-key').catch(() => ({}));
    if (!publicKey) return;
    // Check if already subscribed
    const existing = await reg.pushManager.getSubscription().catch(() => null);
    if (existing) {
      // Ensure server has the subscription (re-subscribe if missing)
      const j = existing.toJSON();
      await api('/push/subscribe', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys } }).catch(() => {});
      localStorage.setItem('push_vapid_key', publicKey);
      console.log('[push] Auto-subscribed: existing subscription restored');
    } else {
      // Permission granted but no subscription - create one
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      const j = sub.toJSON();
      await api('/push/subscribe', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys } });
      localStorage.setItem('push_vapid_key', publicKey);
      console.log('[push] Auto-subscribed: new subscription created');
    }
  } catch (e) {
    console.warn('[push] Auto-subscribe failed:', e?.message || e);
  }
}
/** Unlock audio on the first user interaction (browser autoplay policy). */
document.addEventListener('click', () => {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = audioCtx || new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* audio unsupported */ }
}, { once: true });

// Chime + voice + badge for every push the service worker forwards to this page.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (ev) => {
    const d = ev.data || {};
    if (d.type === 'push-order') {
      playChime();
      speakOrder((d.title || '') + '. ' + (d.body || ''));
      navigate(currentView); // auto-refresh current view so new orders appear instantly
      // Sync badge with actual pending orders from API
      syncBadgeWithPendingOrders();
    }
  });
}

/** Sync app badge with actual pending orders count from API. */
async function syncBadgeWithPendingOrders() {
  if (!('setAppBadge' in navigator)) return;
  try {
    const d = await api('/dashboard');
    const pendingCount = d.pendingOrders || 0;
    currentBadgeCount = pendingCount;
    if (pendingCount > 0) {
      navigator.setAppBadge(pendingCount).catch(() => {});
    } else {
      navigator.clearAppBadge().catch(() => {});
    }
  } catch (e) {
    // API call failed, fall back to increment
    incrementBadgeCount();
  }
}

/** Increment the app badge count by 1 (called on new order push). */
let currentBadgeCount = 0;
function incrementBadgeCount() {
  if (!('setAppBadge' in navigator)) return;
  currentBadgeCount++;
  navigator.setAppBadge(currentBadgeCount).catch(() => {});
}

function updatePushToggles() {
  const s = document.getElementById('push-sound-toggle');
  const v = document.getElementById('push-voice-toggle');
  if (s) s.textContent = pushSoundOn() ? '🔊 On' : '🔇 Off';
  if (v) v.textContent = pushVoiceOn() ? '🗣️ On' : '🚫 Off';
}

/** Refresh the 🔔 card status line (server, devices, browser, this device). */
async function renderPushCard() {
  const line = document.getElementById('push-status-line');
  if (!line) return;
  try {
    await autoResubscribeIfKeyChanged();
    const [status, keyRes] = await Promise.all([api('/push/status'), api('/push/vapid-public-key')]);
    const reg = await ensurePushSW();
    const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
    const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
    line.textContent = [
      'Server: ' + (status.configured ? '✅ configured' : '⚠️ not configured (VAPID keys missing)'),
      'Devices: ' + (status.subscriptions || 0),
      'Browser permission: ' + perm,
      'This device: ' + (sub ? '✅ subscribed' : 'not subscribed'),
    ].join('  ·  ');
  } catch (e) {
    line.textContent = '⚠️ Could not load push status — ' + (e?.message || e);
  }
}

/* ================= SETTINGS ================= */


const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
views.settings = async (main) => {
  const [hours, blocked, slots, storeInfo, branchData] = await Promise.all([
    api('/business-hours'), api('/blocked-dates'), api('/time-slots'), api('/store-info'), api('/branches'),
  ]);
  if (branchData?.branches?.length) BRANCHES = branchData.branches;
  const activeTab = sessionStorage.getItem('settingsTab') || 'notifications';
  main.innerHTML = `
    <h2 class="page-title">Settings</h2>
    <div class="tabs" id="settings-tabs">
      <button class="tab-btn${activeTab === 'notifications' ? ' active' : ''}" data-tab="notifications">🔔 Notifications</button>
      <button class="tab-btn${activeTab === 'schedule' ? ' active' : ''}" data-tab="schedule">🕐 Schedule</button>
      <button class="tab-btn${activeTab === 'store' ? ' active' : ''}" data-tab="store">💳 Payment &amp; Contact</button>
    </div>
    <div class="tab-pane${activeTab === 'notifications' ? ' active' : ''}" data-pane="notifications">
    <div class="card"><h3>🔔 Push Notifications &amp; Sound</h3>
      <p class="muted" id="push-status-line">Checking…</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0">
        <button class="btn sm" id="push-enable">Enable on this device</button>
        <button class="btn ghost sm" id="push-disable">Disable on this device</button>
        <button class="btn ghost sm" id="push-test">Send test notification</button>
      </div>
      <div class="slot-row"><span>🔊 Chime on new order</span><button class="btn ghost sm" id="push-sound-toggle"></button></div>
      <div class="slot-row"><span>🗣️ Read orders aloud</span><span class="row-actions"><button class="btn ghost sm" id="push-voice-toggle"></button><button class="btn ghost sm" id="push-voice-test">Test voice</button></span></div>
      <p class="muted" style="font-size:12px">Chime + voice play while this page is open (even in a background tab) — set per browser. The OS notification itself comes from the service worker.</p>
    </div>
    </div>
    <div class="tab-pane${activeTab === 'schedule' ? ' active' : ''}" data-pane="schedule">
    <div class="card"><h3>🕐 Business Hours</h3>
      ${hours.map((h) => `
        <div class="slot-row" data-day="${h.day_of_week}">
          <span style="width:110px"><b>${DAYS[h.day_of_week]}</b></span>
          <span>${h.closed ? '<span class="badge b-CANCELLED">Closed</span>' : `${esc(h.open_time)} – ${esc(h.close_time)}`}</span>
          <button class="btn ghost sm" data-bh-edit="${h.day_of_week}">Edit</button>
        </div>`).join('')}
    </div>
    <div class="card"><h3>⛔ Closed Dates</h3>
      <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <input type="date" id="bd-date" style="width:auto">
        <input id="bd-reason" placeholder="Reason (holiday…)" style="width:180px">
        <button class="btn sm" id="bd-add">Block Date</button>
      </div>
      ${(blocked.length ? blocked.map((b) => `<div class="slot-row"><span><b>${esc(b.date)}</b> — ${esc(b.reason || '')}</span>
        <button class="btn danger sm" data-bd-del="${esc(b.date)}">Remove</button></div>`).join('')
      : '<p class="muted">No blocked dates.</p>')}
    </div>
    <div class="card"><h3>⏰ Time Slots &amp; Capacity</h3>
      ${slots.map((s) => `
        <div class="slot-row">
          <span><b>${esc(s.label)}</b> <span class="muted">· capacity ${s.max_capacity}</span> ${s.active ? '' : ' <span class="badge b-COMPLETED">inactive</span>'}</span>
          <span class="row-actions">
            <button class="btn ghost sm" data-ts-edit="${s.id}">Edit</button>
            <button class="btn ghost sm" data-ts-toggle="${s.id}">${s.active ? 'Disable' : 'Enable'}</button>
          </span>
        </div>`).join('')}
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <input id="ts-label" placeholder="e.g. 8:00 PM" style="width:130px">
        <input type="number" id="ts-cap" placeholder="capacity" style="width:110px" value="5">
        <button class="btn sm" id="ts-add">Add Slot</button>
      </div>
    </div>
    </div>
    <div class="tab-pane${activeTab === 'store' ? ' active' : ''}" data-pane="store">
    <div class="card"><h3>💳 Payment Details</h3>
      <div class="field"><label>GCash (shown when the customer pays via GCash)</label><input id="si-gcash" value="${esc(storeInfo.payment_gcash || '')}"></div>
      <div class="field"><label>Bank (shown for bank transfers)</label><input id="si-bank" value="${esc(storeInfo.payment_bank || '')}"></div>
      <p class="muted" style="font-size:12px">Leave a field blank to fall back to the server default from the environment.</p>
    </div>
    <div class="card"><h3>📞 Contact Details</h3>
      <div class="row2">
        <div class="field"><label>Phone</label><input id="si-phone" value="${esc(storeInfo.contact_phone || '')}"></div>
        <div class="field"><label>Email</label><input id="si-email" value="${esc(storeInfo.contact_email || '')}"></div>
      </div>
      <div class="field"><label>Address</label><input id="si-address" value="${esc(storeInfo.contact_address || '')}"></div>
      <div class="field"><label>Business hours (short line)</label><input id="si-hours" value="${esc(storeInfo.contact_hours || '')}"></div>
      <button class="btn" id="si-save">Save changes</button>
      <p class="muted" style="font-size:12px;margin-top:8px">Shown to customers in the Messenger bot (payment instructions + Contact Us) and on the web ordering page — changes go live immediately.</p>
    </div>
    <div class="card"><h3>📍 Branches / Locations</h3>
      <div class="field"><label>Branch list (comma separated, e.g. <code>naga, samar</code>)</label>
        <input id="br-list" value="${esc(BRANCHES.join(', '))}"></div>
      <p class="muted" style="font-size:12px;margin-top:8px">Used by <b>Menu → Products</b> and <b>Packages</b> so you can make an item available at specific branches only. Items with no branch restriction stay available everywhere. Renaming a branch does <b>not</b> update items that already have restrictions — edit those items to re-select the new branch name.</p>
      <button class="btn" id="br-save">Save branches</button>
    </div>
    </div>`;

  main.querySelectorAll('[data-bh-edit]').forEach((b) => b.addEventListener('click', () => {
    const h = hours.find((x) => x.day_of_week == b.dataset.bhEdit);
    modal(`<h3>${DAYS[h.day_of_week]} Hours</h3>
      <div class="field"><label>Status</label><select id="bh-closed"><option value="0" ${!h.closed ? 'selected' : ''}>Open</option><option value="1" ${h.closed ? 'selected' : ''}>Closed</option></select></div>
      <div class="row2">
        <div class="field"><label>Open time</label><input id="bh-open" value="${esc(h.open_time)}"></div>
        <div class="field"><label>Close time</label><input id="bh-close" value="${esc(h.close_time)}"></div>
      </div>
      <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" id="bh-save">Save</button></div>`);
    document.getElementById('bh-save').addEventListener('click', async () => {
      await api(`/business-hours/${h.day_of_week}`, {
        method: 'PUT', body: {
          closed: Number(document.getElementById('bh-closed').value),
          open_time: document.getElementById('bh-open').value,
          close_time: document.getElementById('bh-close').value,
        }
      });
      closeModal(); toast('Saved'); navigate('settings');
    });
  }));
  main.querySelector('#bd-add').addEventListener('click', async () => {
    const date = document.getElementById('bd-date').value;
    if (!date) return toast('Pick a date', true);
    await api('/blocked-dates', { method: 'POST', body: { date, reason: document.getElementById('bd-reason').value } });
    toast('Date blocked'); navigate('settings');
  });
  main.querySelectorAll('[data-bd-del]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/blocked-dates/${b.dataset.bdDel}`, { method: 'DELETE' });
    toast('Removed'); navigate('settings');
  }));
  main.querySelector('#ts-add').addEventListener('click', async () => {
    const label = document.getElementById('ts-label').value;
    if (!label) return toast('Label required', true);
    await api('/time-slots', { method: 'POST', body: { label, max_capacity: Number(document.getElementById('ts-cap').value) || 5, sort_order: slots.length } });
    toast('Slot added'); navigate('settings');
  });
  main.querySelectorAll('[data-ts-toggle]').forEach((b) => b.addEventListener('click', async () => {
    const s = slots.find((x) => x.id == b.dataset.tsToggle);
    await api(`/time-slots/${s.id}`, { method: 'PUT', body: { active: s.active ? 0 : 1 } });
    navigate('settings');
  }));
  main.querySelectorAll('[data-ts-edit]').forEach((b) => b.addEventListener('click', () => {
    const s = slots.find((x) => x.id == b.dataset.tsEdit);
    modal(`<h3>Edit Time Slot</h3>
      <div class="row2">
        <div class="field"><label>Label</label><input id="tsl" value="${esc(s.label)}"></div>
        <div class="field"><label>Max capacity</label><input type="number" id="tsc" value="${s.max_capacity}"></div>
      </div>
      <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" id="ts-save">Save</button></div>`);
    document.getElementById('ts-save').addEventListener('click', async () => {
      await api(`/time-slots/${s.id}`, { method: 'PUT', body: { label: document.getElementById('tsl').value, max_capacity: Number(document.getElementById('tsc').value) } });
      closeModal(); toast('Saved'); navigate('settings');
    });
  }));

  // ---- 🔔 Push notifications & sound ----
  updatePushToggles();
  renderPushCard();
  main.querySelector('#push-enable').addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
    await subscribePush();
    toast('Notifications enabled on this device');
    renderPushCard();
  }));
  main.querySelector('#push-disable').addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
    await unsubscribePush();
    toast('Notifications disabled on this device');
    renderPushCard();
  }));
  main.querySelector('#push-test').addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
    const r = await api('/push/test', { method: 'POST' });
    toast(`Test push sent to ${r.sent}/${r.total} device(s)`, !r.sent);
  }));
  main.querySelector('#push-sound-toggle').addEventListener('click', () => {
    localStorage.setItem(PUSH_SOUND_KEY, pushSoundOn() ? '0' : '1');
    updatePushToggles();
    if (pushSoundOn()) playChime();
  });
  main.querySelector('#push-voice-toggle').addEventListener('click', () => {
    localStorage.setItem(PUSH_VOICE_KEY, pushVoiceOn() ? '0' : '1');
    updatePushToggles();
    if (pushVoiceOn()) speakOrder('Voice announcements enabled.');
  });
  main.querySelector('#push-voice-test').addEventListener('click', () => {
    speakOrder('Test. New order P P 1042. Delivery. Total: 450 pesos.');
  });

  // ---- Settings tabs ----
  main.querySelectorAll('#settings-tabs .tab-btn').forEach((b) => b.addEventListener('click', () => {
    sessionStorage.setItem('settingsTab', b.dataset.tab);
    main.querySelectorAll('#settings-tabs .tab-btn').forEach((x) => x.classList.toggle('active', x === b));
    main.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === b.dataset.tab));
  }));

  // ---- 💳 Payment & contact form ----
  main.querySelector('#si-save').addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
    await api('/store-info', { method: 'PUT', body: {
      payment_gcash: document.getElementById('si-gcash').value,
      payment_bank: document.getElementById('si-bank').value,
      contact_phone: document.getElementById('si-phone').value,
      contact_email: document.getElementById('si-email').value,
      contact_address: document.getElementById('si-address').value,
      contact_hours: document.getElementById('si-hours').value,
    } });
    toast('Payment & contact details saved — live for customers');
  }));

  // ---- 📍 Branches / Locations ----
  main.querySelector('#br-save').addEventListener('click', (e) => withBtn(e.currentTarget, async () => {
    const res = await api('/branches', { method: 'PUT', body: { branches: document.getElementById('br-list').value } });
    BRANCHES = (res.branches || BRANCHES).map((b) => String(b).toLowerCase());
    document.getElementById('br-list').value = BRANCHES.join(', ');
    toast('Branches saved — Menu & Packages now use this list');
  }));
};

/* ================= ADMINS (staff accounts) ================= */
views.admins = async (main) => {
  const admins = await api('/admins');
  main.innerHTML = `
    <h2 class="page-title">Admin Accounts</h2>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
        <span class="muted">Admins have full access including account management. Staff can manage daily operations only.</span>
        <button class="btn sm" id="adm-new">＋ Add Admin</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Username</th><th>Role</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody>${admins.map((a) => `
          <tr>
            <td><b>${esc(a.username)}</b>${a.id === ME_ID ? ' <span class="badge b-CONFIRMED">you</span>' : ''}</td>
            <td>${a.role === 'ADMIN' ? '<span class="badge b-COMPLETED">Admin</span>' : '<span class="badge b-PENDING">Staff</span>'}</td>
            <td class="muted">${esc((a.created_at || '').slice(0, 16))}</td>
            <td><div class="row-actions">
              <button class="btn ghost sm" data-a-edit="${a.id}">Edit</button>
              ${a.id === ME_ID ? '' : `<button class="btn danger sm" data-a-del="${a.id}">Delete</button>`}
            </div></td>
          </tr>`).join('')}
        </tbody></table></div>
    </div>`;

  const adminForm = (a) => modal(`<h3>${a ? 'Edit' : 'New'} Admin Account</h3>
    <div class="field"><label>Username</label><input id="af-user" value="${esc(a?.username || '')}"></div>
    <div class="field"><label>${a ? 'New password (leave blank to keep current)' : 'Password'}</label>
      <input id="af-pass" type="password" autocomplete="new-password"></div>
    <div class="field"><label>Role</label><select id="af-role">
      <option value="ADMIN" ${a?.role === 'ADMIN' ? 'selected' : ''}>Admin — full access incl. account management</option>
      <option value="STAFF" ${a && a.role !== 'ADMIN' ? 'selected' : ''}>Staff — daily operations only</option>
    </select></div>
    <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button>
    <button class="btn" id="af-save">Save</button></div>`);
  const saveAdmin = async (a) => {
    const body = {
      username: document.getElementById('af-user').value.trim(),
      role: document.getElementById('af-role').value,
    };
    const pass = document.getElementById('af-pass').value;
    if (!body.username) return toast('Username required', true);
    if (!a && !pass) return toast('Password required', true);
    if (pass) body.password = pass;
    try {
      if (a) await api(`/admins/${a.id}`, { method: 'PUT', body });
      else await api('/admins', { method: 'POST', body });
      closeModal(); toast('Saved'); navigate('admins');
    } catch (err) { toast(err.message, true); }
  };
  main.querySelector('#adm-new').addEventListener('click', () => {
    adminForm(null);
    document.getElementById('af-save').addEventListener('click', () => saveAdmin(null));
  });
  main.querySelectorAll('[data-a-edit]').forEach((b) => b.addEventListener('click', () => {
    const a = admins.find((x) => x.id == b.dataset.aEdit);
    adminForm(a);
    document.getElementById('af-save').addEventListener('click', () => saveAdmin(a));
  }));
  main.querySelectorAll('[data-a-del]').forEach((b) => b.addEventListener('click', async () => {
    const a = admins.find((x) => x.id == b.dataset.aDel);
    if (!confirm(`Delete admin account "${a.username}"?`)) return;
    try {
      await api(`/admins/${a.id}`, { method: 'DELETE' });
      toast('Account deleted'); navigate('admins');
    } catch (err) { toast(err.message, true); }
  }));
};

/* ================= IMAGES (Supabase Storage CRUD) ================= */
views.images = async (main) => {
  let files = [];
  try { files = await api('/uploads-list'); }
  catch (err) { toast(err.message, true); }
  main.innerHTML = `
    <h2 class="page-title">Images</h2>
    <p class="muted" style="margin-bottom:14px">Stored in Supabase Storage bucket. Upload, replace and delete images — URLs stay public for Messenger.</p>
    <div class="card">
      <h3>⬆️ Upload new image</h3>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="file" id="img-file" accept="image/*" style="flex:1;min-width:180px">
        <button class="btn sm" id="img-upload">Upload</button>
      </div>
      <p class="muted" style="margin-top:6px">JPG, PNG, WebP or GIF · max 5 MB. Cropping available when used via Menu/Packages photo fields.</p>
    </div>
    <div class="card">
      <h3>📦 Batch upload</h3>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="file" id="img-batch-file" accept="image/*" multiple style="flex:1;min-width:180px">
        <button class="btn sm" id="img-batch-upload">Upload All</button>
      </div>
      <p class="muted" style="margin-top:6px">Select multiple images at once. Files are uploaded sequentially.</p>
      <div id="batch-progress" style="margin-top:10px;display:none">
        <div style="background:#e5e7eb;border-radius:8px;height:8px;overflow:hidden">
          <div id="batch-progress-bar" style="background:var(--brand);height:100%;width:0%;transition:width 0.3s"></div>
        </div>
        <p class="muted" id="batch-progress-text" style="margin-top:4px;font-size:12px">Uploading...</p>
      </div>
    </div>
    <div class="card"><h3>🖼️ Library (${files.length})</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px" id="img-grid">
        ${files.map((f) => `
          <div style="background:#fafbfc;border-radius:12px;padding:10px;text-align:center">
            <img class="img-skel" src="${esc(f.url)}" style="width:100%;height:100px;object-fit:cover;border-radius:8px" loading="lazy" onload="this.classList.remove('img-skel')" onerror="this.classList.remove('img-skel')">
            <p class="muted" style="margin:6px 0 4px;word-break:break-all;font-size:11px">${esc(f.name)}</p>
            <div class="row-actions" style="justify-content:center">
              <button class="btn ghost sm" data-img-copy="${esc(f.url)}">Copy URL</button>
              <button class="btn danger sm" data-img-del="${esc(f.name)}">Delete</button>
            </div>
          </div>`).join('') || '<p class="muted">No images yet.</p>'}
      </div>
    </div>`;
  main.querySelector('#img-upload').addEventListener('click', async () => {
    const file = main.querySelector('#img-file').files[0];
    if (!file) return toast('Choose a file first', true);
    try {
      const originalSize = file.size;
      toast(`Compressing ${formatFileSize(originalSize)}...`);
      const compressedFile = await compressImage(file);
      const saved = originalSize - compressedFile.size;
      await uploadImage(compressedFile);
      const savedText = saved > 0 ? ` · Saved ${formatFileSize(saved)}` : '';
      toast(`Image uploaded${savedText}`);
      navigate('images');
    } catch (err) { toast(err.message, true); }
  });
  // Batch upload handler
  main.querySelector('#img-batch-upload').addEventListener('click', async () => {
    const fileInput = main.querySelector('#img-batch-file');
    const files = fileInput.files;
    if (!files || files.length === 0) return toast('Choose files first', true);

    const progressDiv = main.querySelector('#batch-progress');
    const progressBar = main.querySelector('#batch-progress-bar');
    const progressText = main.querySelector('#batch-progress-text');
    progressDiv.style.display = 'block';

    let uploaded = 0;
    let failed = 0;
    let totalSaved = 0;
    const total = files.length;

    for (let i = 0; i < total; i++) {
      const file = files[i];
      const originalSize = file.size;
      progressText.textContent = `Processing ${i + 1} of ${total}: ${file.name} (${formatFileSize(originalSize)})`;
      progressBar.style.width = `${((i) / total) * 100}%`;
      try {
        const compressedFile = await compressImage(file);
        totalSaved += (originalSize - compressedFile.size);
        await uploadImage(compressedFile);
        uploaded++;
      } catch (err) {
        failed++;
        console.error('Upload failed for', file.name, err);
      }
    }

    progressBar.style.width = '100%';
    const savedText = totalSaved > 0 ? ` · Saved ${formatFileSize(totalSaved)}` : '';
    progressText.textContent = `Complete! ${uploaded} uploaded, ${failed} failed${savedText}`;

    if (uploaded > 0) {
      toast(`Batch upload complete: ${uploaded} uploaded${failed > 0 ? `, ${failed} failed` : ''}${savedText}`);
      setTimeout(() => navigate('images'), 1500);
    } else {
      toast('All uploads failed', true);
    }
  });
  main.querySelectorAll('[data-img-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.imgCopy); toast('URL copied'); }
    catch { toast('Copy failed', true); }
  }));
  main.querySelectorAll('[data-img-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this image from Supabase Storage? Products/packages using it will lose their photo.')) return;
    try {
      await api('/uploads/' + encodeURIComponent(b.dataset.imgDel), { method: 'DELETE' });
      toast('Image deleted'); navigate('images');
    } catch (err) { toast(err.message, true); }
  }));
};

/* ================= APP BOOT =================
 * Runs last so every view above is registered before the first navigate(). */
(async () => {
  if (TOKEN) { showApp(); return; }
  // Messenger webview: log in once — later "admin2020" opens auto-login via
  // the remembered session; otherwise the login page shows (default state).
  if (await tryRememberedLogin()) showApp();
})();

/* ---- Push: register the service worker + auto-resubscribe if keys changed ---- */
ensurePushSW().then(() => {
  if (TOKEN) autoResubscribeIfKeyChanged().catch(() => {});
}).catch(() => {});

/* ---- Row actions "⋯" more-menu (Orders / Reservations) ----
   The menu uses position:fixed (set by JS) so it escapes the
   .table-wrap overflow clipping and stays inside the viewport on mobile. */
const closeRowMenus = () => document.querySelectorAll('.row-menu.open').forEach((m) => m.classList.remove('open'));
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-menu-btn]');
  if (!btn) { closeRowMenus(); return; }
  e.preventDefault();
  const menu = btn.parentElement.querySelector('.row-menu');
  if (!menu) return;
  const wasOpen = menu.classList.contains('open');
  closeRowMenus();
  if (wasOpen) return;
  menu.classList.add('open');
  const r = btn.getBoundingClientRect();
  const w = menu.offsetWidth;
  let left = r.right - w;                    // align right edge with the ⋯ button
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  menu.style.left = left + 'px';
  // open upward when there isn't room below (common for the last table rows)
  const h = menu.offsetHeight;
  menu.style.top = (r.bottom + h + 12 > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px';
});
document.addEventListener('scroll', closeRowMenus, true);
window.addEventListener('resize', closeRowMenus);
