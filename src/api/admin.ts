import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { one, many, run, query, insertReturningId, tx } from '../db';
import { authMiddleware, requireRole } from './auth';
import { updateOrderStatus, updatePaymentStatus } from '../services/orders';
import { getVapidPublicKey, storeSubscription, removeSubscription, sendPushToAdmins, getPushStatus } from '../services/push';
import {
  createReservation, cancelReservation, updateReservationStatus,
  rescheduleReservation, slotAvailability, isDateOpen,
} from '../services/reservations';
import { computeCartTotals } from '../services/pricing';
import { notifyOrderStatus, notifyOrderOnTheWay, sendRatingRequest, sendText, sendQuickReplies } from '../messenger/send';

const r = Router();
r.use(authMiddleware);

// ---- Dashboard ----
r.get('/dashboard', async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const stats = {
    todayOrders: (await one("SELECT COUNT(*) c FROM orders WHERE date(created_at) = $1", [today]) as any).c,
    pendingOrders: (await one("SELECT COUNT(*) c FROM orders WHERE status = 'PENDING'")).c,
    todaySales: (await one("SELECT COALESCE(SUM(total),0) s FROM orders WHERE date(created_at) = $1 AND status != 'CANCELLED'", [today]) as any).s,
    todayReservations: await many("SELECT * FROM reservations WHERE res_date = $1 AND status != 'CANCELLED' ORDER BY time_slot", [today]),
    recentOrders: await many(`SELECT o.*, c.name AS customer_name FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id ORDER BY o.id DESC LIMIT 10`),
  };
  res.json(stats);
});

// ---- Categories ----
r.get('/categories', async (_req, res) => res.json(await many('SELECT * FROM categories ORDER BY sort_order')));
r.post('/categories', async (req, res) => {
  const { name, sort_order = 0 } = req.body;
  const id = await insertReturningId('INSERT INTO categories (name, sort_order) VALUES ($1, $2) RETURNING id', [name, sort_order]);
  res.json({ id });
});
r.put('/categories/:id', async (req, res) => {
  const { name, active } = req.body;
  await run('UPDATE categories SET name = COALESCE($1, name), active = COALESCE($2, active) WHERE id = $3',
    [name ?? null, active ?? null, req.params.id]);
  res.json({ ok: true });
});
r.delete('/categories/:id', async (req, res) => {
  await run('UPDATE categories SET active = 0 WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---- Products ----
r.get('/products', async (_req, res) => {
  const products = await many('SELECT * FROM products ORDER BY category_id, sort_order') as any[];
  const variants = await many('SELECT * FROM product_variants') as any[];
  res.json(products.map((p: any) => ({ ...p, variants: variants.filter((v: any) => v.product_id === p.id) })));
});
r.post('/products', async (req, res) => {
  const { category_id, name, description, photo_url, variants = [] } = req.body;
  const pid = await tx(async (client) => {
    const prodRes = await client.query('INSERT INTO products (category_id, name, description, photo_url) VALUES ($1, $2, $3, $4) RETURNING id',
      [category_id, name, description ?? null, photo_url ?? null]);
    const pid = Number(prodRes.rows[0].id);
    for (const v of variants) {
      await client.query('INSERT INTO product_variants (product_id, size, price) VALUES ($1, $2, $3)', [pid, v.size, v.price]);
    }
    return pid;
  });
  res.json({ id: pid });
});
r.put('/products/:id', async (req, res) => {
  const { name, description, photo_url, category_id, active, unavailable } = req.body;
  await run(`UPDATE products SET name = COALESCE($1, name), description = COALESCE($2, description),
    photo_url = COALESCE($3, photo_url), category_id = COALESCE($4, category_id),
    active = COALESCE($5, active), unavailable = COALESCE($6, unavailable) WHERE id = $7`,
    [name ?? null, description ?? null, photo_url ?? null, category_id ?? null, active ?? null, unavailable ?? null, req.params.id]);
  res.json({ ok: true });
});
r.delete('/products/:id', async (req, res) => {
  await run('UPDATE products SET active = 0 WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---- Variants ----
r.get('/products/:id/variants', async (req, res) => {
  res.json(await many('SELECT * FROM product_variants WHERE product_id = $1 ORDER BY price', [req.params.id]));
});
r.post('/products/:id/variants', async (req, res) => {
  const { size, price } = req.body;
  const existing = await one('SELECT id FROM product_variants WHERE product_id = $1 AND size = $2', [req.params.id, size]) as any;
  if (existing) {
    await run('UPDATE product_variants SET price = $1 WHERE id = $2', [price, existing.id]);
    res.json({ id: existing.id });
  } else {
    const id = await insertReturningId('INSERT INTO product_variants (product_id, size, price) VALUES ($1, $2, $3) RETURNING id',
      [req.params.id, size, price]);
    res.json({ id });
  }
});
r.put('/products/:id/variants', async (req, res) => {
  const { variants } = req.body;
  if (!Array.isArray(variants)) return res.status(400).json({ error: 'variants must be an array' });

  await tx(async (client) => {
    // Delete existing variants for this product
    await client.query('DELETE FROM product_variants WHERE product_id = $1', [req.params.id]);

    // Insert new variants
    for (const v of variants) {
      await client.query(
        'INSERT INTO product_variants (product_id, size, price) VALUES ($1, $2, $3)',
        [req.params.id, v.size, v.price]
      );
    }
  });

  res.json({ ok: true });
});
r.delete('/variants/:id', async (req, res) => {
  await run('DELETE FROM product_variants WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---- Packages ----
r.get('/packages', async (_req, res) => {
  const packages = await many('SELECT * FROM packages ORDER BY id') as any[];
  const slots = await many('SELECT * FROM package_slots ORDER BY package_id, slot_number') as any[];
  const options = await many('SELECT po.*, p.name AS product_name FROM package_options po JOIN products p ON p.id = po.product_id ORDER BY po.slot_id') as any[];
  res.json(packages.map((p: any) => ({
    ...p,
    slots: slots.filter((s: any) => s.package_id === p.id).map((s: any) => ({
      ...s,
      options: options.filter((o: any) => o.slot_id === s.id),
    })),
  })));
});
r.post('/packages', async (req, res) => {
  const { name, description, photo_url, base_price, selections, discount = 0, is_fixed = 0, is_custom = 0 } = req.body;
  const id = await insertReturningId('INSERT INTO packages (name, description, photo_url, base_price, selections, discount, is_fixed, is_custom) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
    [name, description ?? null, photo_url ?? null, base_price, selections, discount, is_fixed, is_custom]);
  res.json({ id });
});
r.put('/packages/:id', async (req, res) => {
  const { name, description, photo_url, base_price, selections, active, discount, is_fixed, is_custom } = req.body;
  await run(`UPDATE packages SET name = COALESCE($1, name), description = COALESCE($2, description),
    photo_url = COALESCE($3, photo_url), base_price = COALESCE($4, base_price),
    selections = COALESCE($5, selections), active = COALESCE($6, active),
    discount = COALESCE($7, discount), is_fixed = COALESCE($8, is_fixed),
    is_custom = COALESCE($9, is_custom) WHERE id = $10`,
    [name ?? null, description ?? null, photo_url ?? null, base_price ?? null, selections ?? null, active ?? null, discount ?? null, is_fixed ?? null, is_custom ?? null, req.params.id]);
  res.json({ ok: true });
});
r.delete('/packages/:id', async (req, res) => {
  await run('UPDATE packages SET active = 0 WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---- Package Slots ----
r.post('/packages/:id/slots', async (req, res) => {
  const { slot_number } = req.body;
  const pkgId = req.params.id;
  const id = await insertReturningId('INSERT INTO package_slots (package_id, slot_number) VALUES ($1, $2) RETURNING id', [pkgId, slot_number]);
  res.json({ id });
});
r.put('/packages/:id/slots', async (req, res) => {
  const pkgId = req.params.id;
  const { slots } = req.body;
  if (!Array.isArray(slots)) return res.status(400).json({ error: 'slots must be an array' });

  await tx(async (client) => {
    // Delete existing options and slots for this package
    const existingSlots = await client.query('SELECT id FROM package_slots WHERE package_id = $1', [pkgId]);
    for (const s of existingSlots.rows) {
      await client.query('DELETE FROM package_options WHERE slot_id = $1', [s.id]);
    }
    await client.query('DELETE FROM package_slots WHERE package_id = $1', [pkgId]);

    // Insert new slots with options
    for (const slot of slots) {
      const slotRes = await client.query(
        'INSERT INTO package_slots (package_id, slot_number) VALUES ($1, $2) RETURNING id',
        [pkgId, slot.slot_number]
      );
      const slotId = Number(slotRes.rows[0].id);

      // Insert options for this slot
      if (Array.isArray(slot.product_ids)) {
        for (const productId of slot.product_ids) {
          const upgradePrice = slot.upgrade_prices?.[productId] ?? 0;
          const sizeUpgradePrice = slot.size_upgrade_prices?.[productId] ?? 0;
          const isDefault = slot.default_product_id === productId ? 1 : 0;
          await client.query(
            'INSERT INTO package_options (slot_id, product_id, upgrade_price, size_upgrade_price, is_default) VALUES ($1, $2, $3, $4, $5)',
            [slotId, productId, upgradePrice, sizeUpgradePrice, isDefault]
          );
        }
      }
    }
  });

  res.json({ ok: true });
});
r.delete('/slots/:id', async (req, res) => {
  await run('DELETE FROM package_slots WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---- Package Options ----
r.post('/slots/:id/options', async (req, res) => {
  const { product_id, upgrade_price = 0, size_upgrade_price = 0, is_default = 0 } = req.body;
  const slotId = req.params.id;
  const id = await insertReturningId('INSERT INTO package_options (slot_id, product_id, upgrade_price, size_upgrade_price, is_default) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [slotId, product_id, upgrade_price, size_upgrade_price, is_default]);
  res.json({ id });
});
r.put('/options/:id', async (req, res) => {
  const { upgrade_price, size_upgrade_price, is_default } = req.body;
  await run('UPDATE package_options SET upgrade_price = COALESCE($1, upgrade_price), size_upgrade_price = COALESCE($2, size_upgrade_price), is_default = COALESCE($3, is_default) WHERE id = $4',
    [upgrade_price ?? null, size_upgrade_price ?? null, is_default ?? null, req.params.id]);
  res.json({ ok: true });
});
r.delete('/options/:id', async (req, res) => {
  await run('DELETE FROM package_options WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---- Food Packs (simple fixed-price bundles) ----
r.get('/food-packs', async (_req, res) => {
  res.json(await many('SELECT * FROM food_packs ORDER BY sort_order, id'));
});
r.post('/food-packs', async (req, res) => {
  const { name, description, photo_url, price, serves, sort_order = 0, active = 1 } = req.body;
  if (!name || price == null) return res.status(400).json({ error: 'name and price are required' });
  const id = await insertReturningId(
    'INSERT INTO food_packs (name, description, photo_url, price, serves, sort_order, active) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [name, description ?? null, photo_url ?? null, price, serves ?? null, sort_order, active]
  );
  res.json({ id });
});
r.put('/food-packs/:id', async (req, res) => {
  const { name, description, photo_url, price, serves, sort_order, active } = req.body;
  await run(`UPDATE food_packs SET name = COALESCE($1, name), description = COALESCE($2, description),
    photo_url = COALESCE($3, photo_url), price = COALESCE($4, price), serves = COALESCE($5, serves),
    sort_order = COALESCE($6, sort_order), active = COALESCE($7, active) WHERE id = $8`,
    [name ?? null, description ?? null, photo_url ?? null, price ?? null, serves ?? null, sort_order ?? null, active ?? null, req.params.id]);
  res.json({ ok: true });
});
r.delete('/food-packs/:id', async (req, res) => {
  await run('UPDATE food_packs SET active = 0 WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---- Orders ----
r.get('/orders', async (_req, res) => {
  res.json(await many(`SELECT o.*, c.name AS customer_name FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id ORDER BY o.id DESC`));
});
r.get('/orders/:id', async (req, res) => {
  const order = await one('SELECT * FROM orders WHERE id = $1', [req.params.id]) as any;
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const items = await many('SELECT * FROM order_items WHERE order_id = $1', [order.id]) as any[];
  const packageItems = await many('SELECT * FROM order_package_items ORDER BY order_item_id, slot_number') as any[];
  order.items = items.map((i: any) => ({
    ...i,
    package_items: packageItems.filter((pi: any) => pi.order_item_id === i.id),
  }));
  order.status_history = await many('SELECT * FROM order_status_history WHERE order_id = $1 ORDER BY changed_at', [order.id]);
  res.json(order);
});
r.post('/orders/:id/status', async (req, res) => {
  const { status } = req.body;
  const order = await one('SELECT * FROM orders WHERE id = $1', [req.params.id]) as any;
  if (!order) return res.status(404).json({ error: 'Order not found' });
  await updateOrderStatus(order.id, status);
  if (order.customer_id) {
    const customer = await one('SELECT psid FROM customers WHERE id = $1', [order.customer_id]) as any;
    if (customer?.psid) {
      if (status === 'READY') {
        await notifyOrderOnTheWay(customer.psid, order.order_number);
        // Give the customer a one-tap way to complete the order themselves.
        await sendQuickReplies(customer.psid, 'Once you receive your order, tap below:', [
          { title: '✅ Order Received', payload: `COMPLETE:${order.id}` },
          { title: '🏠 Main Menu', payload: 'MAIN_MENU' },
        ]);
      }
      else await notifyOrderStatus(customer.psid, status, order.order_number);
      // Send rating request when order is completed
      if (status === 'COMPLETED') {
        await sendRatingRequest(customer.psid, order.order_number, order.id);
      }
    }
  }
  res.json({ ok: true });
});
// Set a fixed additional discount (₱) on an order; total is recomputed as
// stored_total + previous discount - new discount, never below zero.
// Admin confirms a PENDING order and sets the actual delivery fee (₱) at that point.
// The fee is provided BY the admin — it is not auto-charged from the area estimates.
r.post('/orders/:id/confirm', async (req, res) => {
  const fee = Math.max(0, Math.round(Number(req.body?.delivery_fee) ||  0));
  const order = await one('SELECT * FROM orders WHERE id = $1', [req.params.id]) as any;
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'PENDING') return res.status(400).json({ error: 'Only pending orders can be confirmed' });
  const newTotal = Math.max(0,(Number(order.subtotal) ||  0) - (Number(order.additional_discount) ||  0) + fee);
  await query('UPDATE orders SET status = $1, delivery_fee = $2, total = $3 WHERE id = $4', ['CONFIRMED', fee, newTotal, order.id]);
  await run('INSERT INTO order_status_history (order_id, status) VALUES ($1,$2)', [order.id, 'CONFIRMED']);
  if (order.customer_id) {
    const customer = await one('SELECT psid FROM customers WHERE id = $1', [order.customer_id]) as any;
    if (customer?.psid) {
      await notifyOrderStatus(customer.psid, 'CONFIRMED', order.order_number);
      await sendText(customer.psid, '🚚 Delivery fee: ₱' + fee.toLocaleString('en-PH') + '\n💰 New total: ₱' + newTotal.toLocaleString('en-PH'));
    }
  }
  res.json({ ok: true, total: newTotal, delivery_fee: fee });
});
r.post('/orders/:id/discount', async (req, res) => {
  const discount = Math.max(0, Math.round(Number(req.body?.additional_discount) || 0));
  const order = await one('SELECT * FROM orders WHERE id = $1', [req.params.id]) as any;
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const newTotal = Math.max(0, Number(order.total) + Number(order.additional_discount || 0) - discount);
  await query('UPDATE orders SET additional_discount = $1, total = $2 WHERE id = $3', [discount, newTotal, order.id]);
  res.json({ ok: true, total: newTotal, additional_discount: discount });
});
r.post('/orders/:id/payment-status', async (req, res) => {
  const { payment_status } = req.body;
  await updatePaymentStatus(Number(req.params.id), payment_status);
  res.json({ ok: true });
});

// ---- Order Ratings & Feedback ----
r.get('/ratings', async (_req, res) => {
  const ratings = await many(`
    SELECT r.*, o.order_number, c.name as customer_name
    FROM order_ratings r
    JOIN orders o ON o.id = r.order_id
    LEFT JOIN customers c ON c.id = o.customer_id
    ORDER BY r.created_at DESC
  `);
  res.json(ratings);
});
r.get('/ratings/stats', async (_req, res) => {
  const stats = await one(`
    SELECT
      COUNT(*) as total_ratings,
      ROUND(AVG(rating), 1) as average_rating,
      COUNT(CASE WHEN rating = 5 THEN 1 END) as five_star,
      COUNT(CASE WHEN rating = 4 THEN 1 END) as four_star,
      COUNT(CASE WHEN rating = 3 THEN 1 END) as three_star,
      COUNT(CASE WHEN rating = 2 THEN 1 END) as two_star,
      COUNT(CASE WHEN rating = 1 THEN 1 END) as one_star
    FROM order_ratings
  `);
  res.json(stats);
});

// ---- Customers ----
r.get('/customers', async (_req, res) => {
  res.json(await many('SELECT * FROM customers ORDER BY id DESC'));
});
r.get('/customers/:id', async (req, res) => {
  const customer = await one('SELECT * FROM customers WHERE id = $1', [req.params.id]) as any;
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  customer.orders = await many('SELECT * FROM orders WHERE customer_id = $1 ORDER BY id DESC', [customer.id]);
  res.json(customer);
});

// ---- Delivery Areas ----
r.get('/delivery-areas', async (_req, res) => {
  res.json(await many('SELECT * FROM delivery_areas ORDER BY name'));
});
r.post('/delivery-areas', async (req, res) => {
  const { name, fee } = req.body;
  const id = await insertReturningId('INSERT INTO delivery_areas (name, fee) VALUES ($1, $2) RETURNING id', [name, fee]);
  res.json({ id });
});
r.put('/delivery-areas/:id', async (req, res) => {
  const { name, fee, active } = req.body;
  await run('UPDATE delivery_areas SET name = COALESCE($1, name), fee = COALESCE($2, fee), active = COALESCE($3, active) WHERE id = $4',
    [name ?? null, fee ?? null, active ?? null, req.params.id]);
  res.json({ ok: true });
});
r.delete('/delivery-areas/:id', async (req, res) => {
  await run('UPDATE delivery_areas SET active = 0 WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---- Reservations ----
r.get('/reservations', async (_req, res) => {
  res.json(await many("SELECT * FROM reservations WHERE status != 'CANCELLED' ORDER BY res_date, time_slot"));
});
r.post('/reservations', async (req, res) => {
  try {
    const id = await createReservation(req.body);
    res.json({ id });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
r.post('/reservations/:id/cancel', async (req, res) => {
  await cancelReservation(Number(req.params.id));
  res.json({ ok: true });
});
r.post('/reservations/:id/status', async (req, res) => {
  const { status } = req.body;
  await updateReservationStatus(Number(req.params.id), status);
  res.json({ ok: true });
});
r.post('/reservations/:id/reschedule', async (req, res) => {
  const { res_date, time_slot } = req.body;
  try {
    await rescheduleReservation(Number(req.params.id), res_date, time_slot);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Availability ----
r.get('/availability', async (req, res) => {
  const date = String(req.query.date || '');
  if (!date) return res.status(400).json({ error: 'date is required' });
  const open = await isDateOpen(date);
  if (!open.open) return res.json({ open: false, reason: open.reason, slots: [] });
  res.json({ open: true, slots: await slotAvailability(date) });
});

// ---- Business Hours ----
r.get('/business-hours', async (_req, res) => {
  res.json(await many('SELECT * FROM business_hours ORDER BY day_of_week'));
});
r.put('/business-hours/:day', async (req, res) => {
  const { open_time, close_time, closed } = req.body;
  await run('UPDATE business_hours SET open_time = COALESCE($1, open_time), close_time = COALESCE($2, close_time), closed = COALESCE($3, closed) WHERE day_of_week = $4',
    [open_time ?? null, close_time ?? null, closed ?? null, req.params.day]);
  res.json({ ok: true });
});

// ---- Blocked Dates ----
r.get('/blocked-dates', async (_req, res) => {
  res.json(await many('SELECT * FROM blocked_dates ORDER BY date'));
});
r.post('/blocked-dates', async (req, res) => {
  const { date, reason } = req.body;
  await run('INSERT INTO blocked_dates (date, reason) VALUES ($1, $2) ON CONFLICT (date) DO UPDATE SET reason = EXCLUDED.reason', [date, reason ?? null]);
  res.json({ ok: true });
});
r.delete('/blocked-dates/:date', async (req, res) => {
  await run('DELETE FROM blocked_dates WHERE date = $1', [req.params.date]);
  res.json({ ok: true });
});

// ---- Time Slots ----
r.get('/time-slots', async (_req, res) => {
  res.json(await many('SELECT * FROM time_slots ORDER BY sort_order'));
});
r.post('/time-slots', async (req, res) => {
  const { label, max_capacity } = req.body;
  const id = await insertReturningId('INSERT INTO time_slots (label, max_capacity) VALUES ($1, $2) RETURNING id', [label, max_capacity ?? 5]);
  res.json({ id });
});
r.put('/time-slots/:id', async (req, res) => {
  const { label, max_capacity, active } = req.body;
  await run('UPDATE time_slots SET label = COALESCE($1, label), max_capacity = COALESCE($2, max_capacity), active = COALESCE($3, active) WHERE id = $4',
    [label ?? null, max_capacity ?? null, active ?? null, req.params.id]);
  res.json({ ok: true });
});
r.delete('/time-slots/:id', async (req, res) => {
  await run('UPDATE time_slots SET active = 0 WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---- Payments ----
r.get('/payments', async (_req, res) => {
  res.json(await many('SELECT * FROM payments ORDER BY recorded_at DESC'));
});
r.post('/payments', async (req, res) => {
  const { order_id, method, amount, status = 'PAID' } = req.body;
  await run('INSERT INTO payments (order_id, method, amount, status) VALUES ($1, $2, $3, $4)', [order_id, method, amount, status]);
  await run('UPDATE orders SET payment_status = $1 WHERE id = $2', [status === 'PAID' ? 'PAID' : 'PAYMENT_SUBMITTED', order_id]);
  res.json({ ok: true });
});

// ---- Pricing preview (for admin/testing) ----
r.post('/pricing/preview', async (req, res) => {
  try {
    res.json(await computeCartTotals(req.body.items || [], req.body.delivery_fee || 0));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ---- Admin accounts (only full ADMINs manage these) ----
const requireAdmin = requireRole('ADMIN');

r.get('/admins', requireAdmin, async (_req, res) => {
  res.json(await many('SELECT id, username, role, created_at FROM admins ORDER BY id'));
});

r.post('/admins', requireAdmin, async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !username.trim() || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const name = String(username).trim();
  if (await one('SELECT id FROM admins WHERE username = $1', [name])) {
    return res.status(409).json({ error: 'That username is already taken' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const id = await insertReturningId('INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
    [name, hash, role === 'ADMIN' ? 'ADMIN' : 'STAFF']);
  res.json({ id });
});

r.put('/admins/:id', requireAdmin, async (req, res) => {
  const target = await one('SELECT * FROM admins WHERE id = $1', [req.params.id]) as any;
  if (!target) return res.status(404).json({ error: 'Admin not found' });
  const { username, password, role } = req.body || {};
  const name = username != null ? String(username).trim() : null;
  if (name && name !== target.username && await one('SELECT id FROM admins WHERE username = $1', [name])) {
    return res.status(409).json({ error: 'That username is already taken' });
  }
  if (password != null && password !== '' && String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const nextRole = role != null ? (role === 'ADMIN' ? 'ADMIN' : 'STAFF') : (target.role || 'ADMIN');
  const adminCount = (await one("SELECT COUNT(*) c FROM admins WHERE role = 'ADMIN'") as any).c;
  if ((target.role || 'ADMIN') === 'ADMIN' && nextRole !== 'ADMIN' && adminCount <= 1) {
    return res.status(400).json({ error: 'Cannot remove the last admin account' });
  }
  const hash = password != null && password !== '' ? bcrypt.hashSync(password, 10) : null;
  await run('UPDATE admins SET username = COALESCE($1, username), password_hash = COALESCE($2, password_hash), role = $3 WHERE id = $4',
    [name, hash, nextRole, req.params.id]);
  res.json({ ok: true });
});

r.delete('/admins/:id', requireAdmin, async (req, res) => {
  const target = await one('SELECT * FROM admins WHERE id = $1', [req.params.id]) as any;
  if (!target) return res.status(404).json({ error: 'Admin not found' });
  if (Number((req as any).admin?.sub) === target.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }
  if ((target.role || 'ADMIN') === 'ADMIN') {
    const adminCount = (await one("SELECT COUNT(*) c FROM admins WHERE role = 'ADMIN'") as any).c;
    if (adminCount <= 1) return res.status(400).json({ error: 'Cannot remove the last admin account' });
  }
  await run('DELETE FROM admins WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---- Web Push subscriptions ----
r.get('/push/vapid-public-key', (_req, res) => {
  res.json({ publicKey: getVapidPublicKey() });
});

r.post('/push/subscribe', async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription payload' });
  }
  try {
    await storeSubscription(
      { endpoint, p256dh: keys.p256dh, auth: keys.auth },
      req.get('user-agent') ?? undefined,
    );
    res.json({ ok: true });
  } catch (e: any) {
    console.error('[push] store subscription error', e);
    res.status(500).json({ error: e.message });
  }
});

r.post('/push/unsubscribe', async (req, res) => {
  const { endpoint } = req.query;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  try {
    await removeSubscription(String(endpoint));
    res.json({ ok: true });
  } catch (e: any) {
    console.error('[push] remove subscription error', e);
    res.status(500).json({ error: e.message });
  }
});

// Diagnostics: is push configured on this server, and how many devices listen?
r.get('/push/status', async (_req, res) => {
  try {
    res.json(await getPushStatus());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Sends a test push to every subscribed admin device.
r.post('/push/test', async (_req, res) => {
  try {
    const result = await sendPushToAdmins({
      title: '🔔 Test notification',
      body: 'If you can read this, web push is working end-to-end!',
      tag: 'push-test',
    });
    res.json({ ok: true, ...result });
  } catch (e: any) {
    console.error('[push] test send error', e);
    res.status(500).json({ error: e.message });
  }
});

// ---- App Settings (webview toggle, etc.) ----

r.get('/settings', async (_req, res) => {
  const rows = await many('SELECT key, value FROM app_settings') as any[];
  const settings: Record<string, string> = {};
  for (const row of rows) settings[row.key] = row.value;
  res.json(settings);
});

r.put('/settings/:key', async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;
  if (value == null) return res.status(400).json({ error: 'Missing value' });
  await run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now()::text)
     ON CONFLICT(key) DO UPDATE SET value = $2, updated_at = now()::text`,
    [key, String(value)]
  );
  res.json({ ok: true });
});

export default r;