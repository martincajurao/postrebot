/**
 * Webview API - REST endpoints that mirror the Messenger bot's ordering flow.
 * A session ID (stored in the browser) replaces the Messenger PSID.
 */

import { Router } from 'express';
import { one, many, run, insertReturningId } from '../db';
import { getCart, addItem, removeItem, updateQuantity, cartTotals, clearCart } from '../services/cart';
import { createOrderFromCart, getCustomerOrders, getOrderById, getOrderItems } from '../services/orders';
import { slotAvailability, isDateOpen } from '../services/reservations';

const r = Router();

async function getOrCreateCustomer(sessionId: string): Promise<number> {
  let cust = await one('SELECT id FROM customers WHERE psid = $1', [sessionId]) as any;
  if (!cust) {
    const id = await insertReturningId(
      'INSERT INTO customers (psid, name) VALUES ($1, $2) RETURNING id',
      [sessionId, 'Web Customer']
    );
    return Number(id);
  }
  return Number(cust.id);
}

// ---- Catalog endpoints ----

r.get('/categories', async (_req, res) => {
  const cats = await many('SELECT * FROM categories WHERE active = 1 ORDER BY sort_order');
  res.json(cats);
});

r.get('/products', async (_req, res) => {
  const products = await many('SELECT * FROM products WHERE active = 1 ORDER BY category_id, sort_order') as any[];
  const variants = await many('SELECT * FROM product_variants') as any[];
  res.json(products.map((p: any) => ({
    ...p,
    variants: variants.filter((v: any) => v.product_id === p.id),
  })));
});

r.get('/packages', async (_req, res) => {
  const packages = await many('SELECT * FROM packages WHERE active = 1 ORDER BY sort_order') as any[];
  const result = [];
  for (const pkg of packages) {
    const slots = await many('SELECT * FROM package_slots WHERE package_id = $1 ORDER BY slot_number', [pkg.id]) as any[];
    for (const slot of slots) {
      slot.options = await many(
        `SELECT po.*, p.name, p.photo_url FROM package_options po
         JOIN products p ON p.id = po.product_id WHERE po.slot_id = $1 ORDER BY po.is_default DESC, po.id`,
        [slot.id]
      );
    }
    result.push({ ...pkg, slots });
  }
  res.json(result);
});

r.get('/food-packs', async (_req, res) => {
  const packs = await many('SELECT * FROM food_packs WHERE active = 1 ORDER BY sort_order');
  res.json(packs);
});

// ---- Cart endpoints ----

r.get('/cart', async (req, res) => {
  const sessionId = String(req.query.session || '');
  if (!sessionId) return res.json({ items: [], totals: { subtotal: 0, delivery: 0, total: 0 } });
  const items = await getCart(sessionId);
  const totals = await cartTotals(sessionId);
  res.json({ items, totals });
});

r.post('/cart/add', async (req, res) => {
  const sessionId = String(req.body.session || '');
  if (!sessionId) return res.status(400).json({ error: 'No session' });
  const { product_id, package_id, food_pack_id, variant_size, quantity, slot_choices } = req.body;
  await addItem(sessionId, {
    product_id: product_id ?? null,
    package_id: package_id ?? null,
    food_pack_id: food_pack_id ?? null,
    variant_size: variant_size ?? null,
    quantity: quantity || 1,
    slot_choices: slot_choices ?? null,
  });
  const items = await getCart(sessionId);
  const totals = await cartTotals(sessionId);
  res.json({ ok: true, items, totals });
});

r.post('/cart/remove', async (req, res) => {
  const sessionId = String(req.body.session || '');
  const { item_id } = req.body;
  if (!sessionId || !item_id) return res.status(400).json({ error: 'Missing params' });
  await removeItem(sessionId, Number(item_id));
  const items = await getCart(sessionId);
  const totals = await cartTotals(sessionId);
  res.json({ ok: true, items, totals });
});

r.post('/cart/update-quantity', async (req, res) => {
  const sessionId = String(req.body.session || '');
  const { item_id, quantity } = req.body;
  if (!sessionId || !item_id || quantity == null) return res.status(400).json({ error: 'Missing params' });
  await updateQuantity(sessionId, Number(item_id), Number(quantity));
  const items = await getCart(sessionId);
  const totals = await cartTotals(sessionId);
  res.json({ ok: true, items, totals });
});

r.post('/cart/clear', async (req, res) => {
  const sessionId = String(req.body.session || '');
  if (!sessionId) return res.status(400).json({ error: 'No session' });
  await clearCart(sessionId);
  res.json({ ok: true, items: [], totals: { subtotal: 0, delivery: 0, total: 0 } });
});

// ---- Checkout ----

r.post('/checkout', async (req, res) => {
  const sessionId = String(req.body.session || '');
  if (!sessionId) return res.status(400).json({ error: 'No session' });
  const { order_type, address, phone, payment_method, fulfillment_date, time_slot } = req.body;

  const custId = await getOrCreateCustomer(sessionId);
  if (phone || address) {
    await run('UPDATE customers SET phone = COALESCE($1, phone), address = COALESCE($2, address) WHERE id = $3',
      [phone ?? null, address ?? null, custId]);
  }

  try {
    const order = await createOrderFromCart(sessionId, {
      customer_id: custId,
      order_type: order_type || 'delivery',
      address,
      phone,
      fulfillment_date,
      time_slot,
      payment_method,
    });
    res.json({ ok: true, order_id: order.orderId, order_number: order.orderNumber });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Orders ----

r.get('/orders', async (req, res) => {
  const sessionId = String(req.query.session || '');
  if (!sessionId) return res.json([]);
  const cust = await one('SELECT id FROM customers WHERE psid = $1', [sessionId]) as any;
  if (!cust) return res.json([]);
  const orders = await getCustomerOrders(cust.id);
  res.json(orders);
});

r.get('/orders/:id', async (req, res) => {
  const order = await getOrderById(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Not found' });
  const items = await getOrderItems(Number(req.params.id));
  res.json({ ...order, items });
});

// ---- Reservations / Slots ----

r.get('/slots', async (req, res) => {
  const date = String(req.query.date || '');
  if (!date) return res.status(400).json({ error: 'No date' });
  const open = await isDateOpen(date);
  const slots = await slotAvailability(date);
  res.json({ open, slots });
});

// ---- Config ----

r.get('/config', async (_req, res) => {
  res.json({
    payment: {
      cod: 'Pay in cash when your order arrives.',
      gcash: process.env.PAYMENT_GCASH || 'GCash: 09753122085',
      bank: process.env.PAYMENT_BANK || 'BDO: 0000-0000-0000',
    },
    contact: {
      phone: process.env.CONTACT_PHONE || '0917-000-0000',
      email: process.env.CONTACT_EMAIL || 'hello@postre.example',
      address: process.env.CONTACT_ADDRESS || '123 Sample St.',
      hours: process.env.CONTACT_HOURS || 'Mon-Sat, 10AM-7PM',
    },
  });
});

export default r;
