import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/database';
import { authMiddleware, requireRole } from './auth';
import { updateOrderStatus, updatePaymentStatus } from '../services/orders';
import {
  createReservation, cancelReservation, updateReservationStatus,
  rescheduleReservation, slotAvailability, isDateOpen,
} from '../services/reservations';
import { computeCartTotals, computePackageBasePrice } from '../services/pricing';
import { notifyOrderStatus, notifyOrderOnTheWay } from '../messenger/send';

const r = Router();
r.use(authMiddleware);

// ---- Dashboard ----
r.get('/dashboard', (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const stats = {
    todayOrders: (db.prepare("SELECT COUNT(*) c FROM orders WHERE date(created_at) = ?").get(today) as any).c,
    pendingOrders: (db.prepare("SELECT COUNT(*) c FROM orders WHERE status = 'PENDING'").get() as any).c,
    todaySales: (db.prepare("SELECT COALESCE(SUM(total),0) s FROM orders WHERE date(created_at) = ? AND status != 'CANCELLED'").get(today) as any).s,
    todayReservations: db.prepare("SELECT * FROM reservations WHERE res_date = ? AND status != 'CANCELLED' ORDER BY time_slot").all(today),
    recentOrders: db.prepare(`SELECT o.*, c.name AS customer_name FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id ORDER BY o.id DESC LIMIT 10`).all(),
  };
  res.json(stats);
});

// ---- Categories ----
r.get('/categories', (_req, res) => res.json(db.prepare('SELECT * FROM categories ORDER BY sort_order').all()));
r.post('/categories', (req, res) => {
  const { name, sort_order = 0 } = req.body;
  const out = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)').run(name, sort_order);
  res.json({ id: Number(out.lastInsertRowid) });
});
r.put('/categories/:id', (req, res) => {
  const { name, active } = req.body;
  db.prepare('UPDATE categories SET name = COALESCE(?, name), active = COALESCE(?, active) WHERE id = ?')
    .run(name ?? null, active ?? null, req.params.id);
  res.json({ ok: true });
});
r.delete('/categories/:id', (req, res) => {
  db.prepare('UPDATE categories SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Products ----
r.get('/products', (_req, res) => {
  const products = db.prepare(`SELECT * FROM products ORDER BY category_id, sort_order`).all() as any[];
  const variants = db.prepare('SELECT * FROM product_variants').all() as any[];
  res.json(products.map((p: any) => ({ ...p, variants: variants.filter((v: any) => v.product_id === p.id) })));
});
r.post('/products', (req, res) => {
  const { category_id, name, description, photo_url, variants = [] } = req.body;
  const tx = db.transaction(() => {
    const out = db.prepare('INSERT INTO products (category_id, name, description, photo_url) VALUES (?, ?, ?, ?)')
      .run(category_id, name, description ?? null, photo_url ?? null);
    const pid = Number(out.lastInsertRowid);
    const ins = db.prepare('INSERT INTO product_variants (product_id, size, price) VALUES (?, ?, ?)');
    for (const v of variants) ins.run(pid, v.size, v.price);
    return pid;
  });
  res.json({ id: tx() });
});
r.put('/products/:id', (req, res) => {
  const { name, description, photo_url, category_id, active, unavailable } = req.body;
  db.prepare(`UPDATE products SET name = COALESCE(?, name), description = COALESCE(?, description),
    photo_url = COALESCE(?, photo_url), category_id = COALESCE(?, category_id),
    active = COALESCE(?, active), unavailable = COALESCE(?, unavailable) WHERE id = ?`)
    .run(name ?? null, description ?? null, photo_url ?? null, category_id ?? null,
      active ?? null, unavailable ?? null, req.params.id);
  res.json({ ok: true });
});
r.put('/products/:id/variants', (req, res) => {
  const { variants } = req.body; // [{size, price}]
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM product_variants WHERE product_id = ?').run(req.params.id);
    const ins = db.prepare('INSERT INTO product_variants (product_id, size, price) VALUES (?, ?, ?)');
    for (const v of variants) ins.run(req.params.id, v.size, v.price);
  });
  tx();
  res.json({ ok: true });
});
r.delete('/products/:id', (req, res) => {
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Packages ----
r.get('/packages', (_req, res) => {
  const packages = db.prepare('SELECT * FROM packages').all() as any[];
  const slots = db.prepare('SELECT * FROM package_slots').all() as any[];
  const options = db.prepare(`SELECT po.*, p.name AS product_name FROM package_options po
    JOIN products p ON p.id = po.product_id`).all() as any[];
  res.json(packages.map((p: any) => ({
    ...p,
    slots: slots.filter((s: any) => s.package_id === p.id).map((s: any) => ({
      ...s, options: options.filter((o: any) => o.slot_id === s.id),
    })),
  })));
});
r.post('/packages', (req, res) => {
  const { name, description, photo_url, base_price, discount = 0, selections, is_fixed, is_custom } = req.body;
  const out = db.prepare('INSERT INTO packages (name, description, photo_url, base_price, discount, selections, is_fixed, is_custom) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(name, description ?? null, photo_url ?? null, base_price, Math.max(0, Number(discount) || 0), selections, is_fixed ? 1 : 0, is_custom ? 1 : 0);
  res.json({ id: Number(out.lastInsertRowid) });
});
r.put('/packages/:id', (req, res) => {
  const { name, description, photo_url, base_price, discount, selections, active, is_fixed, is_custom } = req.body;
  // For non-custom packages the base price is NOT manual — it is the sum of the
  // package's items (each slot's default dish). Only custom packages keep a
  // manual set price.
  const pkg = db.prepare('SELECT is_custom FROM packages WHERE id = ?').get(req.params.id) as any;
  const autoPrice = !(pkg?.is_custom || is_custom) ? computePackageBasePrice(Number(req.params.id)) : null;
  db.prepare(`UPDATE packages SET name = COALESCE(?, name), description = COALESCE(?, description),
    photo_url = COALESCE(?, photo_url), base_price = COALESCE(?, base_price), discount = COALESCE(?, discount), selections = COALESCE(?, selections),
    active = COALESCE(?, active), is_fixed = COALESCE(?, is_fixed), is_custom = COALESCE(?, is_custom) WHERE id = ?`)
    .run(name ?? null, description ?? null, photo_url ?? null, autoPrice ?? (base_price ?? null),
      discount == null ? null : Math.max(0, Number(discount) || 0), selections ?? null, active ?? null,
      is_fixed == null ? null : (is_fixed ? 1 : 0), is_custom == null ? null : (is_custom ? 1 : 0), req.params.id);
  res.json({ ok: true });
});
// Set slots: { slots: [{ slot_number: 1, product_ids: [1,2,3], upgrade_prices: {productId: 0}, default_product_id: 1 }] }
r.put('/packages/:id/slots', (req, res) => {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM package_slots WHERE package_id = ?').run(req.params.id);
    const insSlot = db.prepare('INSERT INTO package_slots (package_id, slot_number) VALUES (?, ?)');
    const insOpt = db.prepare('INSERT INTO package_options (slot_id, product_id, upgrade_price, size_upgrade_price, is_default) VALUES (?, ?, ?, ?, ?)');
    for (const s of req.body.slots || []) {
      const sr = insSlot.run(req.params.id, s.slot_number);
      for (const pid of s.product_ids || []) {
        const isDef = s.default_product_id != null && Number(pid) === Number(s.default_product_id) ? 1 : 0;
        insOpt.run(Number(sr.lastInsertRowid), pid, s.upgrade_prices?.[pid] ?? 0, s.size_upgrade_prices?.[pid] ?? 0, isDef);
      }
    }
  });
  tx();
  // Re-derive the base price from the saved slots (non-custom packages only).
  const pkg = db.prepare('SELECT is_custom FROM packages WHERE id = ?').get(req.params.id) as any;
  if (!pkg?.is_custom) {
    db.prepare('UPDATE packages SET base_price = ? WHERE id = ?').run(computePackageBasePrice(Number(req.params.id)), req.params.id);
  }
  res.json({ ok: true });
});
r.delete('/packages/:id', (req, res) => {
  db.prepare('UPDATE packages SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Orders ----
r.get('/orders', (req, res) => {
  const status = req.query.status as string | undefined;
  const rows = db.prepare(`SELECT o.*, c.name AS customer_name, c.phone FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    ${status ? 'WHERE o.status = ?' : ''} ORDER BY o.id DESC`).all(...(status ? [status] : [])) as any[];
  const items = db.prepare('SELECT * FROM order_items').all() as any[];
  res.json(rows.map((o: any) => ({ ...o, items: items.filter((i: any) => i.order_id === o.id) })));
});
r.put('/orders/:id/status', (req, res) => {
  try {
    updateOrderStatus(Number(req.params.id), req.body.status);
    // Notify the customer on Messenger about the status change
    const order = db.prepare("SELECT o.customer_id, c.psid FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?").get(req.params.id) as any;
    if (order?.psid) notifyOrderStatus(order.psid, req.body.status);
    res.json({ ok: true });
  }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});
r.put('/orders/:id/payment', (req, res) => {
  try { updatePaymentStatus(Number(req.params.id), req.body.payment_status); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});
// Rider picked up the order — tell the customer it's on the way.
r.post('/orders/:id/on-the-way', (req, res) => {
  const order = db.prepare("SELECT o.customer_id, c.psid FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?").get(req.params.id) as any;
  if (!order?.psid) return res.status(404).json({ error: 'Order or customer Messenger ID not found' });
  notifyOrderOnTheWay(order.psid);
  res.json({ ok: true });
});

// ---- Reservations ----
r.get('/reservations/availability', (req, res) => {
  const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
  res.json({ date, open: isDateOpen(date), slots: slotAvailability(date) });
});
r.get('/reservations', (req, res) => {
  const date = req.query.date as string | undefined;
  res.json(db.prepare(`SELECT * FROM reservations ${date ? 'WHERE res_date = ?' : ''}
    ORDER BY res_date, time_slot`).all(...(date ? [date] : [])));
});
r.post('/reservations', (req, res) => {
  try {
    const id = createReservation(req.body);
    res.json({ id });
  } catch (e: any) { res.status(409).json({ error: e.message }); }
});
r.put('/reservations/:id/status', (req, res) => {
  try { updateReservationStatus(Number(req.params.id), req.body.status); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});
r.put('/reservations/:id/reschedule', (req, res) => {
  try {
    rescheduleReservation(Number(req.params.id), req.body.res_date, req.body.time_slot);
    res.json({ ok: true });
  } catch (e: any) { res.status(409).json({ error: e.message }); }
});
r.put('/reservations/:id/cancel', (req, res) => {
  cancelReservation(Number(req.params.id));
  res.json({ ok: true });
});

// ---- Customers (members) ----
r.get('/customers', (_req, res) => {
  res.json(db.prepare(`SELECT c.*,
    (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS total_orders,
    (SELECT COALESCE(SUM(total),0) FROM orders o WHERE o.customer_id = c.id AND o.status != 'CANCELLED') AS total_spent
    FROM customers c ORDER BY c.id DESC`).all());
});

r.put('/customers/:id', (req, res) => {
  const { name, phone, address } = req.body || {};
  db.prepare(`UPDATE customers SET name = COALESCE(?, name), phone = COALESCE(?, phone),
    address = COALESCE(?, address) WHERE id = ?`)
    .run(name ?? null, phone ?? null, address ?? null, req.params.id);
  res.json({ ok: true });
});

r.get('/customers/:id/orders', (req, res) => {
  res.json(db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC').all(req.params.id));
});

r.delete('/customers/:id', (req, res) => {
  const cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id) as any;
  if (!cust) return res.status(404).json({ error: 'Member not found' });
  const orderCount = (db.prepare('SELECT COUNT(*) c FROM orders WHERE customer_id = ?').get(cust.id) as any).c;
  if (orderCount > 0) {
    return res.status(409).json({ error: 'This member has orders on record and cannot be deleted. Edit their details instead.' });
  }
  db.transaction(() => {
    db.prepare('DELETE FROM carts WHERE psid = ?').run(cust.psid);
    db.prepare('DELETE FROM customers WHERE id = ?').run(cust.id);
  })();
  res.json({ ok: true });
});

// ---- Delivery areas ----
r.get('/delivery-areas', (_req, res) => res.json(db.prepare('SELECT * FROM delivery_areas').all()));
r.post('/delivery-areas', (req, res) => {
  const out = db.prepare('INSERT INTO delivery_areas (name, fee) VALUES (?, ?)').run(req.body.name, req.body.fee);
  res.json({ id: Number(out.lastInsertRowid) });
});
r.put('/delivery-areas/:id', (req, res) => {
  db.prepare('UPDATE delivery_areas SET name = COALESCE(?, name), fee = COALESCE(?, fee) WHERE id = ?')
    .run(req.body.name ?? null, req.body.fee ?? null, req.params.id);
  res.json({ ok: true });
});
r.delete('/delivery-areas/:id', (req, res) => {
  db.prepare('DELETE FROM delivery_areas WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Settings: business hours, blocked dates, time slots ----
r.get('/business-hours', (_req, res) => res.json(db.prepare('SELECT * FROM business_hours ORDER BY day_of_week').all()));
r.put('/business-hours/:day', (req, res) => {
  db.prepare(`UPDATE business_hours SET open_time = COALESCE(?, open_time),
    close_time = COALESCE(?, close_time), closed = COALESCE(?, closed) WHERE day_of_week = ?`)
    .run(req.body.open_time ?? null, req.body.close_time ?? null, req.body.closed ?? null, req.params.day);
  res.json({ ok: true });
});
r.get('/blocked-dates', (_req, res) => res.json(db.prepare('SELECT * FROM blocked_dates ORDER BY date').all()));
r.post('/blocked-dates', (req, res) => {
  db.prepare('INSERT OR REPLACE INTO blocked_dates (date, reason) VALUES (?, ?)').run(req.body.date, req.body.reason ?? null);
  res.json({ ok: true });
});
r.delete('/blocked-dates/:date', (req, res) => {
  db.prepare('DELETE FROM blocked_dates WHERE date = ?').run(req.params.date);
  res.json({ ok: true });
});
r.get('/time-slots', (_req, res) => res.json(db.prepare('SELECT * FROM time_slots ORDER BY sort_order').all()));
r.put('/time-slots/:id', (req, res) => {
  db.prepare(`UPDATE time_slots SET label = COALESCE(?, label), max_capacity = COALESCE(?, max_capacity),
    active = COALESCE(?, active) WHERE id = ?`)
    .run(req.body.label ?? null, req.body.max_capacity ?? null, req.body.active ?? null, req.params.id);
  res.json({ ok: true });
});
r.post('/time-slots', (req, res) => {
  const out = db.prepare('INSERT INTO time_slots (label, sort_order, max_capacity) VALUES (?, ?, ?)')
    .run(req.body.label, req.body.sort_order ?? 0, req.body.max_capacity ?? 5);
  res.json({ id: Number(out.lastInsertRowid) });
});

// ---- Pricing preview (for admin/testing) ----
r.post('/pricing/preview', (req, res) => {
  try {
    res.json(computeCartTotals(req.body.items || [], req.body.delivery_fee || 0));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ---- Admin accounts (only full ADMINs manage these) ----
const requireAdmin = requireRole('ADMIN');

r.get('/admins', requireAdmin, (_req, res) => {
  res.json(db.prepare('SELECT id, username, role, created_at FROM admins ORDER BY id').all());
});

r.post('/admins', requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !username.trim() || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const name = String(username).trim();
  if (db.prepare('SELECT id FROM admins WHERE username = ?').get(name)) {
    return res.status(409).json({ error: 'That username is already taken' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const out = db.prepare('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)')
    .run(name, hash, role === 'ADMIN' ? 'ADMIN' : 'STAFF');
  res.json({ id: Number(out.lastInsertRowid) });
});

r.put('/admins/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.params.id) as any;
  if (!target) return res.status(404).json({ error: 'Admin not found' });
  const { username, password, role } = req.body || {};
  const name = username != null ? String(username).trim() : null;
  if (name && name !== target.username &&
      db.prepare('SELECT id FROM admins WHERE username = ?').get(name)) {
    return res.status(409).json({ error: 'That username is already taken' });
  }
  if (password != null && password !== '' && String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  // Never leave the system without a full admin.
  const nextRole = role != null ? (role === 'ADMIN' ? 'ADMIN' : 'STAFF') : (target.role || 'ADMIN');
  const adminCount = (db.prepare("SELECT COUNT(*) c FROM admins WHERE role = 'ADMIN'").get() as any).c;
  if ((target.role || 'ADMIN') === 'ADMIN' && nextRole !== 'ADMIN' && adminCount <= 1) {
    return res.status(400).json({ error: 'Cannot remove the last admin account' });
  }
  const hash = password != null && password !== '' ? bcrypt.hashSync(password, 10) : null;
  db.prepare(`UPDATE admins SET username = COALESCE(?, username),
    password_hash = COALESCE(?, password_hash), role = ? WHERE id = ?`)
    .run(name, hash, nextRole, req.params.id);
  res.json({ ok: true });
});

r.delete('/admins/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.params.id) as any;
  if (!target) return res.status(404).json({ error: 'Admin not found' });
  if (Number((req as any).admin?.sub) === target.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }
  if ((target.role || 'ADMIN') === 'ADMIN') {
    const adminCount = (db.prepare("SELECT COUNT(*) c FROM admins WHERE role = 'ADMIN'").get() as any).c;
    if (adminCount <= 1) return res.status(400).json({ error: 'Cannot remove the last admin account' });
  }
  db.prepare('DELETE FROM admins WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default r;
