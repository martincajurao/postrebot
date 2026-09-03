/* Postre Admin SPA */
const API = '/api/admin';
let TOKEN = localStorage.getItem('token') || '';
let ME = localStorage.getItem('me') || '';
let ME_ID = Number(localStorage.getItem('me_id')) || 0;
let ROLE = localStorage.getItem('role') || 'ADMIN';
let currentView = 'dashboard';

// ---------- helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN, ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH');
function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  document.getElementById('toast').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
function modal(html) { document.getElementById('modal').innerHTML = html; document.getElementById('modal-overlay').classList.add('show'); }
function closeModal() { document.getElementById('modal-overlay').classList.remove('show'); }
document.getElementById('modal-overlay').addEventListener('click', (e) => { if (e.target.id === 'modal-overlay') closeModal(); });

// ---------- auth --assad--------
function logout() {
  TOKEN = ''; ME = ''; ME_ID = 0; ROLE = '';
  localStorage.clear();
  location.hash = '';
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-view').style.display = 'flex';
}

function showApp() {
  document.getElementById('login-view').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('whoami').textContent = ME + (ROLE === 'ADMIN' ? ' · Admin' : ' · Staff');
  document.querySelectorAll('[data-view="admins"]').forEach((a) => { a.style.display = ROLE === 'ADMIN' ? '' : 'none'; });
  navigate('dashboard');
}
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: document.getElementById('login-user').value, password: document.getElementById('login-pass').value }),
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
document.getElementById('logout-btn').addEventListener('click', logout);

// ---------- navigation (single source of truth) ----------
const NAV = [
  { view: 'dashboard',    icon: '📊', label: 'Dashboard',    bottom: 'Home' },
  { view: 'orders',       icon: '🛒', label: 'Orders',       bottom: 'Orders' },
  { view: 'reservations', icon: '📅', label: 'Reservations', bottom: 'Resv.' },
  { view: 'menu',         icon: '🍽️', label: 'Menu',         bottom: 'Menu' },
  { view: 'packages',     icon: '🔥', label: 'Packages',     bottom: 'Pkgs',   role: 'ADMIN' },
  { view: 'customers',    icon: '👥', label: 'Customers',    bottom: 'Cust.',  role: 'ADMIN' },
  { view: 'admins',       icon: '🛡️', label: 'Admins',       bottom: 'Admins', role: 'ADMIN' },
  { view: 'delivery',     icon: '🚚', label: 'Delivery',     bottom: 'Deliv.' },
  { view: 'settings',     icon: '⚙️', label: 'Settings',     bottom: 'Settings' },
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
async function uploadImage(file) {
  const fd = new FormData();
  fd.append('image', file);
  const res = await fetch(API + '/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd });
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
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
        <img id="${id}-prev" src="${esc(bustImg(value))}" style="height:44px;width:44px;object-fit:cover;border-radius:8px;display:${value ? 'block' : 'none'}">
      </div>
      <input type="hidden" id="${id}" value="${esc(value || '')}">
      <p class="muted" id="${id}-url" style="margin-top:4px;word-break:break-all">${esc(value || 'No photo')}</p>
    </div>`;
}
function bindPhotoField(id) {
  const input = document.getElementById(id + '-file');
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) return;
    openCropper(file, async (croppedBlob) => {
      try {
        toast('Uploading image…');
        const url = await uploadImage(new File([croppedBlob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }));
        document.getElementById(id).value = url;
        document.getElementById(id + '-url').textContent = url;
        const prev = document.getElementById(id + '-prev');
        prev.src = url; prev.style.display = 'block';
        toast('Image uploaded');
      } catch (err) { toast(err.message, true); }
    });
    input.value = ''; // allow picking the same file again
  });
}

/* ================= IMAGE CROPPER =================
 * Square crop: drag to pan, slider to zoom. Exports a 800x800 JPEG blob.
 * Images are always output square (Messenger carousels crop 1:1 anyway). */
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
    applyCropTransform();
    overlay.classList.add('show');
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

document.getElementById('crop-cancel').addEventListener('click', closeCropper);
document.getElementById('crop-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'crop-overlay') closeCropper();
});
document.getElementById('crop-apply').addEventListener('click', () => {
  if (!cropCtx) return;
  const OUT = 800; // output resolution (square)
  const img = document.getElementById('crop-img');
  const stage = document.getElementById('crop-stage');
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
  ? `<img class="thumb" src="${esc(bustImg(url))}" alt="" title="${esc(title)}" onerror="imgFail(this)">`
  : '<span class="thumb noimg" title="No photo">🖼️</span>';
/* ================= DASHBOARD ================= */
views.dashboard = async (main) => {
  const d = await api('/dashboard');
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
views.orders = async (main) => {
  main.innerHTML = `
    <h2 class="page-title">Orders</h2>
    <div class="card"><div class="table-wrap" id="orders-body"><p class="muted">Loading…</p></div></div>`;
  const filter = sessionStorage.getItem('orderFilter') || '';
  const orders = await api('/orders' + (filter ? '?status=' + filter : ''));
  const filters = ['', 'PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'];
  main.querySelector('#orders-body').innerHTML = `
    <p style="margin-bottom:10px">
      <select id="order-filter" style="width:auto">
        ${filters.map((f) => `<option value="${f}" ${f === filter ? 'selected' : ''}>${f || 'All statuses'}</option>`).join('')}
      </select></p>
    <table>
      <thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Schedule</th><th>Payment</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>
      ${orders.map((o) => `
        <tr>
          <td><b>${esc(o.order_number)}</b><br><span class="muted">${esc((o.created_at || '').slice(0, 10))}</span></td>
          <td>${esc(o.customer_name || '—')}<br><span class="muted">${esc(o.phone || '')}</span></td>
          <td>${(o.items || []).map((i) => `${esc(i.name)} ×${i.quantity}`).join('<br>')}</td>
          <td>${peso(o.total)}</td>
          <td>${o.order_type === 'delivery' ? '🚚 ' + esc(o.address || '') : '🏬 Pickup'}<br><span class="muted">${esc(o.fulfillment_date || '')} ${esc(o.time_slot || '')}</span></td>
          <td><span class="badge b-${esc(o.payment_status)}">${esc(o.payment_status)}</span><br><span class="muted">${esc(o.payment_method || '')}</span></td>
          <td><span class="badge b-${esc(o.status)}">${esc(o.status)}</span></td>
          <td><div class="row-actions">
            ${NEXT_STATUS[o.status] ? `<button class="btn ok sm" data-advance="${o.id}" data-next="${NEXT_STATUS[o.status]}">→ ${NEXT_STATUS[o.status]}</button>` : ''}
            ${o.status !== 'CANCELLED' && o.status !== 'COMPLETED' ? `<button class="btn danger sm" data-cancel="${o.id}">Cancel</button>` : ''}
            ${o.payment_status !== 'PAID' ? `<button class="btn ghost sm" data-paid="${o.id}">Mark Paid</button>` : ''}
          </div></td>
        </tr>`).join('') || '<tr><td colspan="8" class="muted">No orders.</td></tr>'}
      </tbody>
    </table>`;
  main.querySelector('#order-filter').addEventListener('change', (e) => {
    sessionStorage.setItem('orderFilter', e.target.value);
    navigate('orders');
  });
  main.querySelectorAll('[data-advance]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/orders/${b.dataset.advance}/status`, { method: 'PUT', body: { status: b.dataset.next } }); toast('Order → ' + b.dataset.next); navigate('orders'); }
    catch (err) { toast(err.message, true); }
  }));
  main.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Cancel this order?')) return;
    try { await api(`/orders/${b.dataset.cancel}/status`, { method: 'PUT', body: { status: 'CANCELLED' } }); toast('Order cancelled'); navigate('orders'); }
    catch (err) { toast(err.message, true); }
  }));
  main.querySelectorAll('[data-paid]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/orders/${b.dataset.paid}/payment`, { method: 'PUT', body: { payment_status: 'PAID' } }); toast('Marked as paid'); navigate('orders'); }
    catch (err) { toast(err.message, true); }
  }));
};

/* ================= RESERVATIONS ================= */
views.reservations = async (main) => {
  const today = new Date().toISOString().slice(0, 10);
  const date = sessionStorage.getItem('resvDate') || today;
  main.innerHTML = `
    <h2 class="page-title">Reservations</h2>
    <div class="card">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
        <input type="date" id="resv-date" value="${date}" style="width:auto">
        <button class="btn sm" id="resv-new">＋ New Reservation</button>
        <span class="muted" id="resv-open"></span>
      </div>
      <div id="resv-body"><p class="muted">Loading…</p></div>
    </div>`;
  const reload = async () => {
    const [resvs, avail] = await Promise.all([
      api('/reservations?date=' + date), api('/reservations/availability?date=' + date),
    ]);
    main.querySelector('#resv-open').textContent = avail.open.open
      ? `Open — ${avail.slots.filter((s) => !s.full).length}/${avail.slots.length} slots available`
      : 'CLOSED: ' + (avail.open.reason || '');
    main.querySelector('#resv-body').innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Time</th><th>Customer</th><th>Phone</th><th>Order</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>
      ${resvs.map((r) => `
        <tr>
          <td><b>${esc(r.time_slot)}</b></td>
          <td>${esc(r.customer_name)}</td>
          <td>${esc(r.phone || '—')}</td>
          <td>${r.order_id ? '#' + r.order_id : '—'}</td>
          <td><span class="badge b-${esc(r.status)}">${esc(r.status)}</span></td>
          <td><div class="row-actions">
            ${r.status === 'PENDING' ? `<button class="btn ok sm" data-resv-ok="${r.id}">Confirm</button>` : ''}
            ${r.status !== 'CANCELLED' && r.status !== 'COMPLETED' ? `<button class="btn sm" data-resv-move="${r.id}">Reschedule</button>` : ''}
            ${r.status !== 'CANCELLED' ? `<button class="btn danger sm" data-resv-cancel="${r.id}">Cancel</button>` : ''}
          </div></td>
        </tr>`).join('') || '<tr><td colspan="6" class="muted">No reservations for this date.</td></tr>'}
      </tbody></table></div>`;
    main.querySelectorAll('[data-resv-ok]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/reservations/${b.dataset.resvOk}/status`, { method: 'PUT', body: { status: 'CONFIRMED' } });
      toast('Reservation confirmed'); navigate('reservations');
    }));
    main.querySelectorAll('[data-resv-cancel]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Cancel this reservation?')) return;
      await api(`/reservations/${b.dataset.resvCancel}/cancel`, { method: 'PUT' });
      toast('Cancelled'); navigate('reservations');
    }));
    main.querySelectorAll('[data-resv-move]').forEach((b) => b.addEventListener('click', () => {
      const r = resvs.find((x) => x.id == b.dataset.resvMove);
      modal(`<h3>Reschedule reservation</h3>
        <div class="field"><label>Date</label><input type="date" id="mv-date" value="${esc(r.res_date)}"></div>
        <div class="field"><label>Time slot</label><input id="mv-time" value="${esc(r.time_slot)}" placeholder="e.g. 10:00 AM"></div>
        <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button>
        <button class="btn" id="mv-save">Save</button></div>`);
      document.getElementById('mv-save').addEventListener('click', async () => {
        try {
          await api(`/reservations/${r.id}/reschedule`, { method: 'PUT', body: { res_date: document.getElementById('mv-date').value, time_slot: document.getElementById('mv-time').value } });
          closeModal(); toast('Rescheduled'); navigate('reservations');
        } catch (err) { toast(err.message, true); }
      });
    }));
  };
  main.querySelector('#resv-date').addEventListener('change', (e) => { sessionStorage.setItem('resvDate', e.target.value); navigate('reservations'); });
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
    document.getElementById('nr-save').addEventListener('click', async () => {
      try {
        await api('/reservations', { method: 'POST', body: {
          customer_name: document.getElementById('nr-name').value,
          phone: document.getElementById('nr-phone').value,
          res_date: document.getElementById('nr-date').value,
          time_slot: document.getElementById('nr-time').value,
          notes: document.getElementById('nr-notes').value,
        }});
        closeModal(); toast('Reservation created'); navigate('reservations');
      } catch (err) { toast(err.message, true); }
    });
  });
  await reload();
};

/* ================= MENU ================= */
views.menu = async (main) => {
  const [products, cats] = await Promise.all([api('/products'), api('/categories')]);
  main.innerHTML = `
    <h2 class="page-title">Menu</h2>
    <div class="card">
      <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap">
        <button class="btn sm" id="prod-new">＋ Add Product</button>
        <button class="btn ghost sm" id="cat-new">＋ Add Category</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Photo</th><th>Product</th><th>Category</th><th>Variants (M/L)</th><th>Availability</th><th>Actions</th></tr></thead>
        <tbody>
        ${products.map((p) => `
          <tr>
            <td>${imgTag(p.photo_url, p.name)}</td>
            <td><b>${esc(p.name)}</b><br><span class="muted">${esc(p.description || '')}</span></td>
            <td>${esc((cats.find((c) => c.id === p.category_id) || {}).name || '—')}</td>
            <td>${(p.variants || []).map((v) => `${esc(v.size)} ${peso(v.price)}`).join(' • ') || '<span class="muted">none</span>'}</td>
            <td>${p.unavailable ? '<span class="badge b-CANCELLED">Unavailable</span>' : (p.active ? '<span class="badge b-CONFIRMED">Available</span>' : '<span class="badge b-COMPLETED">Inactive</span>')}</td>
            <td><div class="row-actions">
              <button class="btn ghost sm" data-edit="${p.id}">Edit</button>
              <button class="btn ghost sm" data-variants="${p.id}">Prices</button>
              <button class="btn danger sm" data-deact="${p.id}">${p.active ? 'Disable' : 'Enable'}</button>
            </div></td>
          </tr>`).join('') || '<tr><td colspan="6" class="muted">No products.</td></tr>'}
        </tbody></table></div>
    </div>`;

  const productForm = (p) => modal(`<h3>${p ? 'Edit' : 'New'} Product</h3>
    <div class="field"><label>Name</label><input id="pf-name" value="${esc(p?.name || '')}"></div>
    <div class="field"><label>Category</label><select id="pf-cat">${cats.map((c) => `<option value="${c.id}" ${p?.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Description</label><input id="pf-desc" value="${esc(p?.description || '')}"></div>
    ${photoField('pf-photo', p?.photo_url)}
    <div class="field"><label>Mark unavailable?</label><select id="pf-un"><option value="0">No</option><option value="1" ${p?.unavailable ? 'selected' : ''}>Yes</option></select></div>
    <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button>
    <button class="btn" id="pf-save">Save</button></div>`);
  const saveProduct = async (p) => {
    const body = {
      name: document.getElementById('pf-name').value,
      category_id: Number(document.getElementById('pf-cat').value),
      description: document.getElementById('pf-desc').value,
      photo_url: document.getElementById('pf-photo').value,
      unavailable: Number(document.getElementById('pf-un').value),
    };
    try {
      if (p) await api(`/products/${p.id}`, { method: 'PUT', body });
      else await api('/products', { method: 'POST', body: { ...body, variants: [] } });
      closeModal(); toast('Saved'); navigate('menu');
    } catch (err) { toast(err.message, true); }
  };
  main.querySelector('#prod-new').addEventListener('click', () => { productForm(null); bindPhotoField('pf-photo'); document.getElementById('pf-save').addEventListener('click', () => saveProduct(null)); });
  main.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    const p = products.find((x) => x.id == b.dataset.edit);
    productForm(p); bindPhotoField('pf-photo'); document.getElementById('pf-save').addEventListener('click', () => saveProduct(p));
  }));
  main.querySelectorAll('[data-variants]').forEach((b) => b.addEventListener('click', () => {
    const p = products.find((x) => x.id == b.dataset.variants);
    const m = p.variants.find((v) => v.size === 'M'), l = p.variants.find((v) => v.size === 'L');
    modal(`<h3>M/L Prices — ${esc(p.name)}</h3>
      <div class="row2">
        <div class="field"><label>M price (₱)</label><input type="number" id="vp-m" value="${m?.price ?? ''}"></div>
        <div class="field"><label>L price (₱)</label><input type="number" id="vp-l" value="${l?.price ?? ''}"></div>
      </div>
      <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn" id="vp-save">Save</button></div>`);
    document.getElementById('vp-save').addEventListener('click', async () => {
      try {
        await api(`/products/${p.id}/variants`, { method: 'PUT', body: { variants: [
          { size: 'M', price: Number(document.getElementById('vp-m').value) },
          { size: 'L', price: Number(document.getElementById('vp-l').value) },
        ] }});
        closeModal(); toast('Prices updated'); navigate('menu');
      } catch (err) { toast(err.message, true); }
    });
  }));
  main.querySelectorAll('[data-deact]').forEach((b) => b.addEventListener('click', async () => {
    const p = products.find((x) => x.id == b.dataset.deact);
    await api(`/products/${p.id}`, { method: 'PUT', body: { active: p.active ? 0 : 1 } });
    toast(p.active ? 'Product disabled' : 'Product enabled'); navigate('menu');
  }));
  main.querySelector('#cat-new').addEventListener('click', () => {
    modal(`<h3>New Category</h3><div class="field"><label>Name</label><input id="cn-name"></div>
      <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" id="cn-save">Add</button></div>`);
    document.getElementById('cn-save').addEventListener('click', async () => {
      await api('/categories', { method: 'POST', body: { name: document.getElementById('cn-name').value } });
      closeModal(); toast('Category added'); navigate('menu');
    });
  });
};

/* ================= PACKAGES ================= */
views.packages = async (main) => {
  const [packages, products] = await Promise.all([api('/packages'), api('/products')]);
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
            ${p.active ? '' : ' <span class="badge b-CANCELLED">inactive</span>'}</div>
          </div>
          <div class="row-actions">
            <button class="btn ghost sm" data-pkg-edit="${p.id}">Edit</button>
            <button class="btn danger sm" data-pkg-toggle="${p.id}">${p.active ? 'Disable' : 'Enable'}</button>
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
  const optRowHtml = (o) => `<div style="display:flex;gap:6px;margin-bottom:6px;align-items:center">
      <select style="flex:2" class="opt-prod">${products.map((x) => `<option value="${x.id}" ${x.id === o.product_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      <input type="number" style="flex:1" placeholder="upgrade ₱" class="opt-up" value="${o.upgrade_price}">
      <input type="number" style="flex:1" placeholder="L +₱" class="opt-lup" value="${o.size_upgrade_price}">
      <button class="btn danger sm" onclick="this.closest('div').remove()">✕</button>
    </div>`;
  /** Full package editor: profile + photo + fixed flag + all slots, saved together. */
  function openPackageEditor(p, draft = null) {
    const info = draft?.info || { name: p.name, description: p.description || '', base_price: p.base_price, discount: p.discount || 0, selections: p.selections, photo_url: p.photo_url || '', is_fixed: !!p.is_fixed };
    const slots = draft?.slots || slotRowsOf(p, info.selections);
    const render = () => modal(`<h3>Edit Package — ${esc(p.name)}</h3>
      <div class="field"><label>Name</label><input id="pn-name" value="${esc(info.name)}"></div>
      <div class="field"><label>Description</label><input id="pn-desc" value="${esc(info.description)}"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
        <div class="field"><label>Base price (₱)</label><input type="number" id="pn-price" value="${info.base_price}"></div>
        <div class="field"><label>Discount (₱)</label><input type="number" id="pn-disc" value="${info.discount || 0}" min="0"></div>
        <div class="field"><label>Selections (slots)</label><input type="number" id="pn-sel" value="${info.selections}" min="1" max="10"></div>
      </div>
      ${photoField('pn-photo', info.photo_url)}
      <div class="field"><label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--ink)">
        <input type="checkbox" id="pn-fixed" style="width:auto" ${info.is_fixed ? 'checked' : ''}> Fixed package (dishes pre-set — customers cannot change them)</label></div>
      ${p.is_custom ? '<p class="muted">Custom package: every slot accepts <b>all menu dishes</b> automatically. Options below only set upgrade prices / defaults.</p>' : ''}
      <h3 style="margin:6px 0 10px">Slots &amp; dish options</h3>
      ${slots.map((s) => `
        <div class="card" style="box-shadow:none;border:1px solid #eee;padding:12px;margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
            <b>Slot ${s.n}</b>
            <select style="max-width:55%" class="slot-def" data-n="${s.n}" title="Pre-selected dish (★). Used as-is for fixed packages.">
              <option value="">Default dish (first option)</option>
              ${products.map((x) => `<option value="${x.id}" ${x.id === s.default_product_id ? 'selected' : ''}>★ ${esc(x.name)}</option>`).join('')}
            </select>
          </div>
          <div id="slot-opts-${s.n}" style="margin-top:8px">${s.options.map((o) => optRowHtml(o)).join('')}</div>
          <button type="button" class="btn ghost sm" onclick="addOptRow(${s.n})">＋ Add dish option</button>
        </div>`).join('')}
      <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" id="pn-save">Save Package</button></div>`);
    render();
    bindPhotoField('pn-photo');
    window.addOptRow = (n) => {
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;align-items:center';
      div.innerHTML = `<select style="flex:2" class="opt-prod">${products.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>
        <input type="number" style="flex:1" placeholder="upgrade ₱" class="opt-up" value="0">
        <input type="number" style="flex:1" placeholder="L +₱" class="opt-lup" value="0">
        <button class="btn danger sm" onclick="this.closest('div').remove()">✕</button>`;
      document.getElementById('slot-opts-' + n).appendChild(div);
    };
    const readInfo = () => ({
      name: document.getElementById('pn-name').value,
      description: document.getElementById('pn-desc').value,
      base_price: Number(document.getElementById('pn-price').value),
      discount: Math.max(0, Number(document.getElementById('pn-disc').value) || 0),
      selections: Number(document.getElementById('pn-sel').value),
      photo_url: document.getElementById('pn-photo').value,
      is_fixed: document.getElementById('pn-fixed').checked ? 1 : 0,
    });
    const readSlots = (count) => {
      const modalEl = document.getElementById('modal');
      return Array.from({ length: count }, (_, i) => {
        const n = i + 1;
        const opts = Array.from(modalEl.querySelectorAll(`#slot-opts-${n} > div`)).map((row) => ({
          product_id: Number(row.querySelector('.opt-prod').value),
          upgrade_price: Number(row.querySelector('.opt-up').value) || 0,
          size_upgrade_price: Number(row.querySelector('.opt-lup').value) || 0,
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
    document.getElementById('pn-save').addEventListener('click', async () => {
      const infoBody = readInfo();
      try {
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
      } catch (err) { toast(err.message, true); }
    });
  }

  main.querySelector('#pkg-new').addEventListener('click', () => {
    modal(`<h3>New Package</h3>
      <div class="field"><label>Name</label><input id="np-name"></div>
      <div class="field"><label>Description</label><input id="np-desc"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
        <div class="field"><label>Base price (₱)</label><input type="number" id="np-price"></div>
        <div class="field"><label>Discount (₱)</label><input type="number" id="np-disc" value="0" min="0"></div>
        <div class="field"><label>Selections (slots)</label><input type="number" id="np-sel" value="4" min="1" max="10"></div>
      </div>
      ${photoField('np-photo', null)}
      <div class="field"><label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--ink)">
        <input type="checkbox" id="np-fixed" style="width:auto"> Fixed package (dishes pre-set — customers cannot change them)</label></div>
      <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" id="np-save">Create &amp; Add Dishes</button></div>`);
    bindPhotoField('np-photo');
    document.getElementById('np-save').addEventListener('click', async () => {
      try {
        const name = document.getElementById('np-name').value.trim();
        if (!name) throw new Error('Package name is required.');
        const created = await api('/packages', { method: 'POST', body: {
          name,
          description: document.getElementById('np-desc').value,
          base_price: Number(document.getElementById('np-price').value),
          discount: Math.max(0, Number(document.getElementById('np-disc').value) || 0),
          selections: Number(document.getElementById('np-sel').value),
          photo_url: document.getElementById('np-photo').value,
          is_fixed: document.getElementById('np-fixed').checked ? 1 : 0,
        }});
        toast('Package created — now add its dishes');
        const fresh = await api('/packages');
        const p = fresh.find((x) => x.id === created.id);
        if (p) openPackageEditor(p); else navigate('packages');
      } catch (err) { toast(err.message, true); }
    });
  });
  main.querySelectorAll('[data-pkg-edit]').forEach((b) => b.addEventListener('click', () => {
    const p = packages.find((x) => x.id == b.dataset.pkgEdit);
    openPackageEditor(p);
  }));
  main.querySelectorAll('[data-pkg-toggle]').forEach((b) => b.addEventListener('click', async () => {
    const p = packages.find((x) => x.id == b.dataset.pkgToggle);
    await api(`/packages/${p.id}`, { method: 'PUT', body: { active: p.active ? 0 : 1 } });
    navigate('packages');
  }));
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
        await api(`/customers/${c.id}`, { method: 'PUT', body: {
          name: document.getElementById('ce-name').value,
          phone: document.getElementById('ce-phone').value,
          address: document.getElementById('ce-address').value,
        }});
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

/* ================= SETTINGS ================= */
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
views.settings = async (main) => {
  const [hours, blocked, slots] = await Promise.all([
    api('/business-hours'), api('/blocked-dates'), api('/time-slots'),
  ]);
  main.innerHTML = `
    <h2 class="page-title">Settings</h2>
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
      await api(`/business-hours/${h.day_of_week}`, { method: 'PUT', body: {
        closed: Number(document.getElementById('bh-closed').value),
        open_time: document.getElementById('bh-open').value,
        close_time: document.getElementById('bh-close').value,
      }});
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

/* ================= APP BOOT =================
 * Runs last so every view above is registered before the first navigate(). */
if (TOKEN) showApp();
