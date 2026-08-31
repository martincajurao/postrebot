import { Router } from 'express';
import { db } from '../db/database';
import { authMiddleware } from './auth';
import { updateOrderStatus, updatePaymentStatus } from '../services/orders';
import {
  createReservation, cancelReservation, updateReservationStatus,
  rescheduleReservation, slotAvailability, isDateOpen,
} from '../services/reservations';
import { computeCartTotals } from '../services/pricing';
import { notifyOrderStatus } from '../messenger/send';

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
  const { name, description, photo_url, base_price, selections, is_fixed, is_custom } = req.body;
  const out = db.prepare('INSERT INTO packages (name, description, photo_url, base_price, selections, is_fixed, is_custom) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name, description ?? null, photo_url ?? null, base_price, selections, is_fixed ? 1 : 0, is_custom ? 1 : 0);
  res.json({ id: Number(out.lastInsertRowid) });
});
r.put('/packages/:id', (req, res) => {
  const { name, description, base_price, selections, active, is_fixed, is_custom } = req.body;
  db.prepare(`UPDATE packages SET name = COALESCE(?, name), description = COALESCE(?, description),
    base_price = COALESCE(?, base_price), selections = COALESCE(?, selections),
    active = COALESCE(?, active), is_fixed = COALESCE(?, is_fixed), is_custom = COALESCE(?, is_custom) WHERE id = ?`)
    .run(name ?? null, description ?? null, base_price ?? null, selections ?? null, active ?? null,
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

// ---- Customers ----
r.get('/customers', (_req, res) => {
  res.json(db.prepare(`SELECT c.*,
    (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS total_orders,
    (SELECT COALESCE(SUM(total),0) FROM orders o WHERE o.customer_id = c.id AND o.status != 'CANCELLED') AS total_spent
    FROM customers c ORDER BY c.id DESC`).all());
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

export default r;
