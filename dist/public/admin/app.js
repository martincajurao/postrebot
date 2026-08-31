/* Postre Admin SPA */
const API = '/api/admin';
let TOKEN = sessionStorage.getItem('token') || '';
let ME = sessionStorage.getItem('me') || '';
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

// ---------- auth ----------
function logout() {
  TOKEN = ''; ME = '';
  sessionStorage.clear();
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-view').style.display = 'flex';
}
if (TOKEN) showApp();

function showApp() {
  document.getElementById('login-view').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('whoami').textContent = ME;
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
    TOKEN = data.token; ME = document.getElementById('login-user').value;
    sessionStorage.setItem('token', TOKEN); sessionStorage.setItem('me', ME);
    document.getElementById('login-err').textContent = '';
    showApp();
  } catch (err) { document.getElementById('login-err').textContent = err.message; }
});
document.getElementById('logout-btn').addEventListener('click', logout);

// ---------- navigation ----------
document.querySelectorAll('[data-view]').forEach((a) =>
  a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.dataset.view); }));

function navigate(view) {
  currentView = view;
  document.querySelectorAll('[data-view]').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  const main = document.getElementById('main');
  main.innerHTML = '<p class="muted">Loading…</p>';
  views[view](main).catch((err) => { main.innerHTML = ''; toast(err.message, true); });
}

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
function photoField(id, value) {
  return `
    <div class="field"><label>Photo</label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="file" id="${id}-file" accept="image/*" style="flex:1;min-width:150px">
        <img id="${id}-prev" src="${esc(value || '')}" style="height:44px;width:44px;object-fit:cover;border-radius:8px;display:${value ? 'block' : 'none'}">
      </div>
      <input type="hidden" id="${id}" value="${esc(value || '')}">
      <p class="muted" id="${id}-url" style="margin-top:4px;word-break:break-all">${esc(value || 'No photo')}</p>
    </div>`;
}
function bindPhotoField(id) {
  const input = document.getElementById(id + '-file');
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      toast('Uploading image…');
      const url = await uploadImage(file);
      document.getElementById(id).value = url;
      document.getElementById(id + '-url').textContent = url;
      const prev = document.getElementById(id + '-prev');
      prev.src = url; prev.style.display = 'block';
      toast('Image uploaded');
    } catch (err) { toast(err.message, true); }
  });
}
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
        <thead><tr><th>Product</th><th>Category</th><th>Variants (M/L)</th><th>Availability</th><th>Actions</th></tr></thead>
        <tbody>
        ${products.map((p) => `
          <tr>
            <td><b>${esc(p.name)}</b><br><span class="muted">${esc(p.description || '')}</span></td>
            <td>${esc((cats.find((c) => c.id === p.category_id) || {}).name || '—')}</td>
            <td>${(p.variants || []).map((v) => `${esc(v.size)} ${peso(v.price)}`).join(' • ') || '<span class="muted">none</span>'}</td>
            <td>${p.unavailable ? '<span class="badge b-CANCELLED">Unavailable</span>' : (p.active ? '<span class="badge b-CONFIRMED">Available</span>' : '<span class="badge b-COMPLETED">Inactive</span>')}</td>
            <td><div class="row-actions">
              <button class="btn ghost sm" data-edit="${p.id}">Edit</button>
              <button class="btn ghost sm" data-variants="${p.id}">Prices</button>
              <button class="btn danger sm" data-deact="${p.id}">${p.active ? 'Disable' : 'Enable'}</button>
            </div></td>
          </tr>`).join('') || '<tr><td colspan="5" class="muted">No products.</td></tr>'}
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
          <div><b>${esc(p.name)}</b> — ${peso(p.base_price)}, choose ${p.selections} dishes
            ${p.is_fixed ? ' <span class="badge b-COMPLETED">fixed</span>' : ''}
            ${p.is_custom ? ' <span class="badge b-CONFIRMED">custom</span>' : ''}
            ${p.active ? '' : ' <span class="badge b-CANCELLED">inactive</span>'}</div>
          <div class="row-actions">
            <button class="btn ghost sm" data-pkg-edit="${p.id}">Edit</button>
            <button class="btn ghost sm" data-pkg-slots="${p.id}">Build Slots</button>
            <button class="btn danger sm" data-pkg-toggle="${p.id}">${p.active ? 'Disable' : 'Enable'}</button>
          </div>
        </div>
        <div style="margin-top:10px" class="muted">
          ${(p.slots || []).map((s) => `Slot ${s.slot_number}: ${s.options.map((o) => esc(o.product_name) + ((o.upgrade_price || 0) ? ` (+${o.upgrade_price})` : '') + (o.is_default ? ' ★' : '')).join(', ') || 'empty'}`).join('<br>')}
        </div>
      </div>`).join('')}`;

  main.querySelector('#pkg-new').addEventListener('click', () => {
    modal(`<h3>New Package</h3>
      <div class="field"><label>Name</label><input id="pn-name"></div>
      <div class="field"><label>Description</label><input id="pn-desc"></div>
      <div class="row2">
        <div class="field"><label>Base price (₱)</label><input type="number" id="pn-price"></div>
        <div class="field"><label>Selections</label><input type="number" id="pn-sel" value="4"></div>
      </div>
      ${photoField('pn-photo', null)}
      <div class="field"><label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--ink)">
        <input type="checkbox" id="pn-fixed" style="width:auto"> Fixed package (dishes pre-set — customers cannot change them)</label></div>
      <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" id="pn-save">Create</button></div>`);
    bindPhotoField('pn-photo');
    document.getElementById('pn-save').addEventListener('click', async () => {
      try {
        await api('/packages', { method: 'POST', body: {
          name: document.getElementById('pn-name').value,
          description: document.getElementById('pn-desc').value,
          base_price: Number(document.getElementById('pn-price').value),
          selections: Number(document.getElementById('pn-sel').value),
          photo_url: document.getElementById('pn-photo').value,
          is_fixed: document.getElementById('pn-fixed').checked ? 1 : 0,
        }});
        closeModal(); toast('Package created — now build its slots'); navigate('packages');
      } catch (err) { toast(err.message, true); }
    });
  });
  main.querySelectorAll('[data-pkg-edit]').forEach((b) => b.addEventListener('click', () => {
    const p = packages.find((x) => x.id == b.dataset.pkgEdit);
    modal(`<h3>Edit Package</h3>
      <div class="field"><label>Name</label><input id="pn-name" value="${esc(p.name)}"></div>
      <div class="field"><label>Description</label><input id="pn-desc" value="${esc(p.description || '')}"></div>
      <div class="row2">
        <div class="field"><label>Base price (₱)</label><input type="number" id="pn-price" value="${p.base_price}"></div>
        <div class="field"><label>Selections</label><input type="number" id="pn-sel" value="${p.selections}"></div>
      </div>
      ${photoField('pn-photo', p.photo_url)}
      <div class="field"><label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--ink)">
        <input type="checkbox" id="pn-fixed" style="width:auto" ${p.is_fixed ? 'checked' : ''}> Fixed package (dishes pre-set — customers cannot change them)</label></div>
      <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" id="pn-save">Save</button></div>`);
    bindPhotoField('pn-photo');
    document.getElementById('pn-save').addEventListener('click', async () => {
      await api(`/packages/${p.id}`, { method: 'PUT', body: {
        name: document.getElementById('pn-name').value,
        description: document.getElementById('pn-desc').value,
        base_price: Number(document.getElementById('pn-price').value),
        selections: Number(document.getElementById('pn-sel').value),
        photo_url: document.getElementById('pn-photo').value,
        is_fixed: document.getElementById('pn-fixed').checked ? 1 : 0,
      }});
      closeModal(); toast('Saved'); navigate('packages');
    });
  }));
  main.querySelectorAll('[data-pkg-toggle]').forEach((b) => b.addEventListener('click', async () => {
    const p = packages.find((x) => x.id == b.dataset.pkgToggle);
    await api(`/packages/${p.id}`, { method: 'PUT', body: { active: p.active ? 0 : 1 } });
    navigate('packages');
  }));
  // ---- slot builder ----
  main.querySelectorAll('[data-pkg-slots]').forEach((b) => b.addEventListener('click', () => {
    const p = packages.find((x) => x.id == b.dataset.pkgSlots);
    const rows = Array.from({ length: p.selections }, (_, i) => i + 1);
    const slotState = rows.map((n) => {
      const s = (p.slots || []).find((x) => x.slot_number === n);
      const def = (s?.options || []).find((o) => o.is_default);
      return { n, default_product_id: def ? def.product_id : null, options: (s?.options || []).map((o) => ({ product_id: o.product_id, upgrade_price: o.upgrade_price || 0, size_upgrade_price: o.size_upgrade_price || 0 })) };
    });
    const render = () => modal(`<h3>Package Builder — ${esc(p.name)}</h3>
      ${p.is_custom ? '<p class="muted" style="margin-bottom:10px">Custom package: every slot accepts <b>all menu dishes</b> automatically. Add options only to set upgrade prices or a preferred default.</p>' : ''}
      ${slotState.map((s) => `
        <div class="card" style="box-shadow:none;border:1px solid #eee;padding:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
            <b>Slot ${s.n}</b>
            <select style="max-width:55%" class="slot-def" data-n="${s.n}" title="Pre-selected dish (★). Used as-is for fixed packages.">
              <option value="">Default dish (first option)</option>
              ${products.map((x) => `<option value="${x.id}" ${x.id === s.default_product_id ? 'selected' : ''}>★ ${esc(x.name)}</option>`).join('')}
            </select>
          </div>
          <div id="slot-opts-${s.n}" style="margin-top:8px">
            ${s.options.map((o, idx) => {
              const prod = products.find((x) => x.id === o.product_id);
              return `<div style="display:flex;gap:6px;margin-bottom:6px;align-items:center">
                <select style="flex:2" data-s="${s.n}" data-i="${idx}" class="opt-prod">
                  ${products.map((x) => `<option value="${x.id}" ${x.id === o.product_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
                </select>
                <input type="number" style="flex:1" placeholder="upgrade ₱" value="${o.upgrade_price}" data-s="${s.n}" data-i="${idx}" class="opt-up">
                <input type="number" style="flex:1" placeholder="L +₱" value="${o.size_upgrade_price}" data-s="${s.n}" data-i="${idx}" class="opt-lup">
                <button class="btn danger sm" onclick="this.closest('div').remove()">✕</button>
              </div>`;
            }).join('')}
          </div>
          <button class="btn ghost sm" onclick="addOptRow(${s.n})">＋ Add dish option</button>
        </div>`).join('')}
      <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" id="slots-save">Save Slots</button></div>`);
    render();
    window.addOptRow = (n) => {
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;align-items:center';
      div.innerHTML = `<select style="flex:2" class="opt-prod">${products.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>
        <input type="number" style="flex:1" placeholder="upgrade ₱" class="opt-up" value="0">
        <input type="number" style="flex:1" placeholder="L +₱" class="opt-lup" value="0">
        <button class="btn danger sm" onclick="this.closest('div').remove()">✕</button>`;
      document.getElementById('slot-opts-' + n).appendChild(div);
    };
    document.getElementById('slots-save').addEventListener('click', async () => {
      const modalEl = document.getElementById('modal');
      try {
        const slots = rows.map((n) => {
          const opts = Array.from(modalEl.querySelectorAll(`#slot-opts-${n} > div`)).map((row) => ({
            product_id: Number(row.querySelector('.opt-prod').value),
            upgrade_price: Number(row.querySelector('.opt-up').value) || 0,
            size_upgrade_price: Number(row.querySelector('.opt-lup').value) || 0,
          }));
          const upgrade_prices = {}, size_upgrade_prices = {};
          opts.forEach((o) => { upgrade_prices[o.product_id] = o.upgrade_price; size_upgrade_prices[o.product_id] = o.size_upgrade_price; });
          const defSel = modalEl.querySelector(`.slot-def[data-n="${n}"]`);
          const default_product_id = defSel && defSel.value ? Number(defSel.value) : undefined;
          if (default_product_id && !opts.some((o) => o.product_id === default_product_id)) {
            throw new Error(`Slot ${n}: the default dish must be one of the slot's dish options.`);
          }
          return { slot_number: n, product_ids: opts.map((o) => o.product_id), upgrade_prices, size_upgrade_prices, default_product_id };
        });
        await api(`/packages/${p.id}/slots`, { method: 'PUT', body: { slots } });
        closeModal(); toast('Slots saved'); navigate('packages');
      } catch (err) { toast(err.message, true); }
    });
  }));
};

/* ================= CUSTOMERS ================= */
views.customers = async (main) => {
  const customers = await api('/customers');
  main.innerHTML = `
    <h2 class="page-title">Customers</h2>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Messenger ID</th><th>Phone</th><th>Address</th><th>Orders</th><th>Total Spent</th></tr></thead>
      <tbody>${customers.map((c) => `
        <tr>
          <td><b>${esc(c.name || 'Unnamed')}</b></td>
          <td class="muted">${esc(c.psid)}</td>
          <td>${esc(c.phone || '—')}</td>
          <td>${esc(c.address || '—')}</td>
          <td>${c.total_orders}</td>
          <td>${peso(c.total_spent)}</td>
        </tr>`).join('') || '<tr><td colspan="6" class="muted">No customers yet.</td></tr>'}
      </tbody></table></div></div>`;
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
