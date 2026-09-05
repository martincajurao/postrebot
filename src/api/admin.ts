import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { supa } from '../db/supabase';
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
  const [todayOrders, pendingOrders, todayRows, todayRes, recentRows] = await Promise.all([
    supa().from('orders').select('id', { count: 'exact', head: true }).like('created_at', today + '%'),
    supa().from('orders').select('id', { count: 'exact', head: true }).eq('status', 'PENDING'),
    supa().from('orders').select('total').like('created_at', today + '%').neq('status', 'CANCELLED'),
    supa().from('reservations').select('*').eq('res_date', today).neq('status', 'CANCELLED').order('time_slot'),
    supa().from('orders').select('*, customers(name)').order('id', { ascending: false }).limit(10),
  ]);
  const stats = {
    todayOrders: todayOrders.count ?? 0,
    pendingOrders: pendingOrders.count ?? 0,
    todaySales: (todayRows.data || []).reduce((s: number, r: any) => s + (Number(r.total) || 0), 0),
    todayReservations: todayRes.data || [],
    recentOrders: (recentRows.data || []).map((o: any) => ({ ...o, customer_name: o.customers?.name ?? null, customers: undefined })),
  };
  res.json(stats);
});

// ---- Categories ----
r.get('/categories', async (_req, res) => {
  const { data } = await supa().from('categories').select('*').order('sort_order');
  res.json(data || []);
});
r.post('/categories', async (req, res) => {
  const { name, sort_order = 0 } = req.body;
  const { data, error } = await supa().from('categories').insert({ name, sort_order }).select('id').single();
  if (error) return res.status(400).json({ error: error.message });
  const id = Number(data.id);
  res.json({ id });
});
r.put('/categories/:id', async (req, res) => {
  const { name, active } = req.body;
  const upd: Record<string, any> = {};
  if (name != null) upd.name = name;
  if (active != null) upd.active = active;
  if (Object.keys(upd).length > 0) await supa().from('categories').update(upd).eq('id', req.params.id);
  res.json({ ok: true });
});
r.delete('/categories/:id', async (req, res) => {
  await supa().from('categories').update({ active: 0 }).eq('id', req.params.id);
  res.json({ ok: true });
});

// ---- Products ----
r.get('/products', async (_req, res) => {
  const [prodRows, varRows] = await Promise.all([
    supa().from('products').select('*').order('category_id, sort_order'),
    supa().from('product_variants').select('*'),
  ]);
  const products = prodRows.data || [];
  const variants = varRows.data || [];
  res.json(products.map((p: any) => ({ ...p, variants: variants.filter((v: any) => v.product_id === p.id) })));
});
r.post('/products', async (req, res) => {
  const { category_id, name, description, photo_url, variants = [] } = req.body;
  const { data: prodRow, error: prodErr } = await supa().from('products')
    .insert({ category_id, name, description: description ?? null, photo_url: photo_url ?? null })
    .select('id').single();
  if (prodErr) return res.status(400).json({ error: prodErr.message });
  const pid = Number(prodRow.id);
  if (variants.length > 0) {
    const { error: varErr } = await supa().from('product_variants')
      .insert(variants.map((v: any) => ({ product_id: pid, size: v.size, price: v.price })));
    if (varErr) return res.status(400).json({ error: varErr.message });
  }
  res.json({ id: pid });
});
r.put('/products/:id', async (req, res) => {
  const { name, description, photo_url, category_id, active, unavailable } = req.body;
  const upd: Record<string, any> = {};
  if (name != null) upd.name = name;
  if (description != null) upd.description = description;
  if (photo_url != null) upd.photo_url = photo_url;
  if (category_id != null) upd.category_id = category_id;
  if (active != null) upd.active = active;
  if (unavailable != null) upd.unavailable = unavailable;
  if (Object.keys(upd).length > 0) await supa().from('products').update(upd).eq('id', req.params.id);
  res.json({ ok: true });
});
r.delete('/products/:id', async (req, res) => {
  await supa().from('products').update({ active: 0 }).eq('id', req.params.id);
  res.json({ ok: true });
});

// ---- Variants ----
r.get('/products/:id/variants', async (req, res) => {
  const { data } = await supa().from('product_variants').select('*').eq('product_id', req.params.id).order('price');
  res.json(data || []);
});
r.post('/products/:id/variants', async (req, res) => {
  const { size, price } = req.body;
  const { data: existing } = await supa().from('product_variants').select('id').eq('product_id', req.params.id).eq('size', size).maybeSingle();
  if (existing) {
    await supa().from('product_variants').update({ price }).eq('id', existing.id);
    res.json({ id: existing.id });
  } else {
    const { data, error } = await supa().from('product_variants').insert({ product_id: req.params.id, size, price }).select('id').single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ id: Number(data.id) });
  }
});
r.put('/products/:id/variants', async (req, res) => {
  const { variants } = req.body;
  if (!Array.isArray(variants)) return res.status(400).json({ error: 'variants must be an array' });

  // Replace all variants for this product
  await supa().from('product_variants').delete().eq('product_id', req.params.id);
  if (variants.length > 0) {
    const { error } = await supa().from('product_variants')
      .insert(variants.map((v: any) => ({ product_id: req.params.id, size: v.size, price: v.price })));
    if (error) return res.status(400).json({ error: error.message });
  }
  res.json({ ok: true });
});
r.delete('/variants/:id', async (req, res) => {
  await supa().from('product_variants').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ---- Packages ----
r.get('/packages', async (_req, res) => {
  const [pkgRows, slotRows] = await Promise.all([
    supa().from('packages').select('*').order('id'),
    supa().from('package_slots').select('*').order('package_id, slot_number'),
  ]);
  const packages = pkgRows.data || [];
  const slots = slotRows.data || [];
  // options for every known package slot
  const { data: options } = await supa().from('package_options').select('*, products(name)');
  const opts = (options || []).map((o: any) => ({ ...o, product_name: o.products?.name ?? null, products: undefined }));
  res.json(packages.map((p: any) => ({
    ...p,
    slots: slots.filter((s: any) => s.package_id === p.id).map((s: any) => ({
      ...s,
      options: opts.filter((o: any) => o.slot_id === s.id),
    })),
  })));
});
r.post('/packages', async (req, res) => {
  const { name, description, photo_url, base_price, selections, discount = 0, is_fixed = 0, is_custom = 0 } = req.body;
  const { data, error } = await supa().from('packages')
    .insert({ name, description: description ?? null, photo_url: photo_url ?? null, base_price, selections, discount, is_fixed, is_custom })
    .select('id').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ id: Number(data.id) });
});
r.put('/packages/:id', async (req, res) => {
  const { name, description, photo_url, base_price, selections, active, discount, is_fixed, is_custom } = req.body;
  const upd: Record<string, any> = {};
  if (name != null) upd.name = name;
  if (description != null) upd.description = description;
  if (photo_url != null) upd.photo_url = photo_url;
  if (base_price != null) upd.base_price = base_price;
  if (selections != null) upd.selections = selections;
  if (active != null) upd.active = active;
  if (discount != null) upd.discount = discount;
  if (is_fixed != null) upd.is_fixed = is_fixed;
  if (is_custom != null) upd.is_custom = is_custom;
  if (Object.keys(upd).length > 0) await supa().from('packages').update(upd).eq('id', req.params.id);
  res.json({ ok: true });
});
r.delete('/packages/:id', async (req, res) => {
  await supa().from('packages').update({ active: 0 }).eq('id', req.params.id);
  res.json({ ok: true });
});

// ---- Package Slots ----
r.post('/packages/:id/slots', async (req, res) => {
  const { slot_number } = req.body;
  const pkgId = req.params.id;
  const { data, error } = await supa().from('package_slots').insert({ package_id: pkgId, slot_number }).select('id').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ id: Number(data.id) });
});
r.put('/packages/:id/slots', async (req, res) => {
  const pkgId = req.params.id;
  const { slots } = req.body;
  if (!Array.isArray(slots)) return res.status(400).json({ error: 'slots must be an array' });

  // Replace all slots + options for this package
  const { data: existingSlots } = await supa().from('package_slots').select('id').eq('package_id', pkgId);
  for (const s of existingSlots || []) {
    await supa().from('package_options').delete().eq('slot_id', s.id);
  }
  await supa().from('package_slots').delete().eq('package_id', pkgId);

  for (const slot of slots) {
    const { data: slotRow, error: slotErr } = await supa().from('package_slots')
      .insert({ package_id: pkgId, slot_number: slot.slot_number }).select('id').single();
    if (slotErr) return res.status(400).json({ error: slotErr.message });
    const slotId = Number(slotRow.id);

    if (Array.isArray(slot.product_ids) && slot.product_ids.length > 0) {
      const rows = slot.product_ids.map((productId: any) => ({
        slot_id: slotId,
        product_id: productId,
        upgrade_price: slot.upgrade_prices?.[productId] ?? 0,
        size_upgrade_price: slot.size_upgrade_prices?.[productId] ?? 0,
        is_default: slot.default_product_id === productId ? 1 : 0,
      }));
      const { error: optErr } = await supa().from('package_options').insert(rows);
      if (optErr) return res.status(400).json({ error: optErr.message });
    }
  }
  res.json({ ok: true });
});
r.delete('/slots/:id', async (req, res) => {
  await supa().from('package_slots').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ---- Package Options ----
r.post('/slots/:id/options', async (req, res) => {
  const { product_id, upgrade_price = 0, size_upgrade_price = 0, is_default = 0 } = req.body;
  const slotId = req.params.id;
  const { data, error } = await supa().from('package_options')
    .insert({ slot_id: slotId, product_id, upgrade_price, size_upgrade_price, is_default })
    .select('id').single();
  if (error) return res.status(400).json({ error: error.message });
  const id = Number(data.id);
  res.json({ id });
});
r.put('/options/:id', async (req, res) => {
  const { upgrade_price, size_upgrade_price, is_default } = req.body;
  const upd: Record<string, any> = {};
  if (upgrade_price != null) upd.upgrade_price = upgrade_price;
  if (size_upgrade_price != null) upd.size_upgrade_price = size_upgrade_price;
  if (is_default != null) upd.is_default = is_default;
  if (Object.keys(upd).length > 0) await supa().from('package_options').update(upd).eq('id', req.params.id);
  res.json({ ok: true });
});
r.delete('/options/:id', async (req, res) => {
  await supa().from('package_options').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ---- Food Packs (simple fixed-price bundles) ----
r.get('/food-packs', async (_req, res) => {
  const { data } = await supa().from('food_packs').select('*').order('sort_order, id');
  res.json(data || []);
});
r.post('/food-packs', async (req, res) => {
  const { name, description, photo_url, price, serves, sort_order = 0, active = 1 } = req.body;
  if (!name || price == null) return res.status(400).json({ error: 'name and price are required' });
  const { data, error } = await supa().from('food_packs')
    .insert({ name, description: description ?? null, photo_url: photo_url ?? null, price, serves: serves ?? null, sort_order, active })
    .select('id').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ id: Number(data.id) });
});
r.put('/food-packs/:id', async (req, res) => {
  const { name, description, photo_url, price, serves, sort_order, active } = req.body;
  const upd: Record<string, any> = {};
  if (name != null) upd.name = name;
  if (description != null) upd.description = description;
  if (photo_url != null) upd.photo_url = photo_url;
  if (price != null) upd.price = price;
  if (serves != null) upd.serves = serves;
  if (sort_order != null) upd.sort_order = sort_order;
  if (active != null) upd.active = active;
  if (Object.keys(upd).length > 0) await supa().from('food_packs').update(upd).eq('id', req.params.id);
  res.json({ ok: true });
});
r.delete('/food-packs/:id', async (req, res) => {
  await supa().from('food_packs').update({ active: 0 }).eq('id', req.params.id);
  res.json({ ok: true });
});

// ---- Orders ----
r.get('/orders', async (_req, res) => {
  const { data } = await supa().from('orders').select('*, customers(name)').order('id', { ascending: false });
  res.json((data || []).map((o: any) => ({ ...o, customer_name: o.customers?.name ?? null, customers: undefined })));
});
r.get('/orders/:id', async (req, res) => {
  const { data: order } = await supa().from('orders').select('*').eq('id', req.params.id).maybeSingle();
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const [itemsRes, pkgRes, histRes] = await Promise.all([
    supa().from('order_items').select('*').eq('order_id', order.id),
    supa().from('order_package_items').select('*').order('order_item_id, slot_number'),
    supa().from('order_status_history').select('*').eq('order_id', order.id).order('created_at'),
  ]);
  const items = itemsRes.data || [];
  const packageItems = pkgRes.data || [];
  order.items = items.map((i: any) => ({
    ...i,
    package_items: packageItems.filter((pi: any) => pi.order_item_id === i.id),
  }));
  order.status_history = histRes.data || [];
  res.json(order);
});
r.post('/orders/:id/status', async (req, res) => {
  const { status } = req.body;
  const { data: order } = await supa().from('orders').select('*').eq('id', req.params.id).maybeSingle();
  if (!order) return res.status(404).json({ error: 'Order not found' });
  await updateOrderStatus(order.id, status);
  if (order.customer_id) {
    const customer = await supa().from('customers').select('psid').eq('id', order.customer_id).maybeSingle();
    if (customer?.data?.psid) {
      if (status === 'READY') {
        await notifyOrderOnTheWay(customer.data.psid, order.order_number);
        // Give the customer a one-tap way to complete the order themselves.
        await sendQuickReplies(customer.data.psid, 'Once you receive your order, tap below:', [
          { title: '✅ Order Received', payload: `COMPLETE:${order.id}` },
          { title: '🏠 Main Menu', payload: 'MAIN_MENU' },
        ]);
      }
      else await notifyOrderStatus(customer.data.psid, status, order.order_number);
      // Send rating request when order is completed
      if (status === 'COMPLETED') {
        await sendRatingRequest(customer.data.psid, order.order_number, order.id);
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
  const { data: order } = await supa().from('orders').select('*').eq('id', req.params.id).maybeSingle();
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'PENDING') return res.status(400).json({ error: 'Only pending orders can be confirmed' });
  const newTotal = Math.max(0,(Number(order.subtotal) ||  0) - (Number(order.additional_discount) ||  0) + fee);
  await supa().from('orders').update({ status: 'CONFIRMED', delivery_fee: fee, total: newTotal }).eq('id', order.id);
  await supa().from('order_status_history').insert({ order_id: order.id, status: 'CONFIRMED' });
  if (order.customer_id) {
    const customer = await supa().from('customers').select('psid').eq('id', order.customer_id).maybeSingle();
    if (customer?.data?.psid) {
      await notifyOrderStatus(customer.data.psid, 'CONFIRMED', order.order_number);
      await sendText(customer.data.psid, '🚚 Delivery fee: ₱' + fee.toLocaleString('en-PH') + '\n💰 New total: ₱' + newTotal.toLocaleString('en-PH'));
    }
  }
  res.json({ ok: true, total: newTotal, delivery_fee: fee });
});
r.post('/orders/:id/discount', async (req, res) => {
  const discount = Math.max(0, Math.round(Number(req.body?.additional_discount) || 0));
  const { data: order } = await supa().from('orders').select('*').eq('id', req.params.id).maybeSingle();
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const newTotal = Math.max(0, Number(order.total) + Number(order.additional_discount || 0) - discount);
  await supa().from('orders').update({ additional_discount: discount, total: newTotal }).eq('id', order.id);
  res.json({ ok: true, total: newTotal, additional_discount: discount });
});
r.post('/orders/:id/payment-status', async (req, res) => {
  const { payment_status } = req.body;
  await updatePaymentStatus(Number(req.params.id), payment_status);
  res.json({ ok: true });
});

// ---- Order Ratings & Feedback ----
r.get('/ratings', async (_req, res) => {
  const { data } = await supa().from('order_ratings')
    .select('*, orders(order_number, customers(name))')
    .order('created_at', { ascending: false });
  res.json((data || []).map((r: any) => ({
    ...r,
    order_number: r.orders?.order_number ?? null,
    customer_name: r.orders?.customers?.name ?? null,
    orders: undefined,
  })));
});
r.get('/ratings/stats', async (_req, res) => {
  const { data } = await supa().from('order_ratings').select('rating');
  const rows = data || [];
  const total = rows.length;
  const count = (n: number) => rows.filter((r) => Number(r.rating) === n).length;
  const stats = {
    total_ratings: total,
    average_rating: total ? Math.round((rows.reduce((s, r) => s + Number(r.rating), 0) / total) * 10) / 10 : 0,
    five_star: count(5),
    four_star: count(4),
    three_star: count(3),
    two_star: count(2),
    one_star: count(1),
  };
  res.json(stats);
});

// ---- Customers ----
r.get('/customers', async (_req, res) => {
  const { data } = await supa().from('customers').select('*').order('id', { ascending: false });
  res.json(data || []);
});
r.get('/customers/:id', async (req, res) => {
  const { data: customer } = await supa().from('customers').select('*').eq('id', req.params.id).maybeSingle();
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const { data: orders } = await supa().from('orders').select('*').eq('customer_id', customer.id).order('id', { ascending: false });
  customer.orders = orders || [];
  res.json(customer);
});

// ---- Delivery Areas ----
r.get('/delivery-areas', async (_req, res) => {
  const { data } = await supa().from('delivery_areas').select('*').order('name');
  res.json(data || []);
});
r.post('/delivery-areas', async (req, res) => {
  const { name, fee } = req.body;
  const { data, error } = await supa().from('delivery_areas').insert({ name, fee }).select('id').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ id: Number(data.id) });
});
r.put('/delivery-areas/:id', async (req, res) => {
  const { name, fee, active } = req.body;
  const upd: Record<string, any> = {};
  if (name != null) upd.name = name;
  if (fee != null) upd.fee = fee;
  if (active != null) upd.active = active;
  if (Object.keys(upd).length > 0) await supa().from('delivery_areas').update(upd).eq('id', req.params.id);
  res.json({ ok: true });
});
r.delete('/delivery-areas/:id', async (req, res) => {
  await supa().from('delivery_areas').update({ active: 0 }).eq('id', req.params.id);
  res.json({ ok: true });
});

// ---- Reservations ----
r.get('/reservations', async (_req, res) => {
  const { data } = await supa().from('reservations').select('*').neq('status', 'CANCELLED').order('res_date, time_slot');
  res.json(data || []);
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
  const { data } = await supa().from('business_hours').select('*').order('day_of_week');
  res.json(data || []);
});
r.put('/business-hours/:day', async (req, res) => {
  const { open_time, close_time, closed } = req.body;
  const upd: Record<string, any> = {};
  if (open_time != null) upd.open_time = open_time;
  if (close_time != null) upd.close_time = close_time;
  if (closed != null) upd.closed = closed;
  if (Object.keys(upd).length > 0) await supa().from('business_hours').update(upd).eq('day_of_week', req.params.day);
  res.json({ ok: true });
});

// ---- Blocked Dates ----
r.get('/blocked-dates', async (_req, res) => {
  const { data } = await supa().from('blocked_dates').select('*').order('date');
  res.json(data || []);
});
r.post('/blocked-dates', async (req, res) => {
  const { date, reason } = req.body;
  const { data: existing } = await supa().from('blocked_dates').select('date').eq('date', date).maybeSingle();
  if (existing) {
    await supa().from('blocked_dates').update({ reason: reason ?? null }).eq('date', date);
  } else {
    await supa().from('blocked_dates').insert({ date, reason: reason ?? null });
  }
  res.json({ ok: true });
});
r.delete('/blocked-dates/:date', async (req, res) => {
  await supa().from('blocked_dates').delete().eq('date', req.params.date);
  res.json({ ok: true });
});

// ---- Time Slots ----
r.get('/time-slots', async (_req, res) => {
  const { data } = await supa().from('time_slots').select('*').order('sort_order');
  res.json(data || []);
});
r.post('/time-slots', async (req, res) => {
  const { label, max_capacity } = req.body;
  const { data, error } = await supa().from('time_slots').insert({ label, max_capacity: max_capacity ?? 5 }).select('id').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ id: Number(data.id) });
});
r.put('/time-slots/:id', async (req, res) => {
  const { label, max_capacity, active } = req.body;
  const upd: Record<string, any> = {};
  if (label != null) upd.label = label;
  if (max_capacity != null) upd.max_capacity = max_capacity;
  if (active != null) upd.active = active;
  if (Object.keys(upd).length > 0) await supa().from('time_slots').update(upd).eq('id', req.params.id);
  res.json({ ok: true });
});
r.delete('/time-slots/:id', async (req, res) => {
  await supa().from('time_slots').update({ active: 0 }).eq('id', req.params.id);
  res.json({ ok: true });
});

// ---- Payments ----
r.get('/payments', async (_req, res) => {
  const { data } = await supa().from('payments').select('*').order('recorded_at', { ascending: false });
  res.json(data || []);
});
r.post('/payments', async (req, res) => {
  const { order_id, method, amount, status = 'PAID' } = req.body;
  await supa().from('payments').insert({ order_id, method, amount, status });
  await supa().from('orders').update({ payment_status: status === 'PAID' ? 'PAID' : 'PAYMENT_SUBMITTED' }).eq('id', order_id);
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
  const { data } = await supa().from('admins').select('id, username, role, created_at').order('id');
  res.json(data || []);
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
  const { data: existing } = await supa().from('admins').select('id').eq('username', name).maybeSingle();
  if (existing) {
    return res.status(409).json({ error: 'That username is already taken' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const { data, error } = await supa().from('admins')
    .insert({ username: name, password_hash: hash, role: role === 'ADMIN' ? 'ADMIN' : 'STAFF' })
    .select('id').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ id: Number(data.id) });
});

r.put('/admins/:id', requireAdmin, async (req, res) => {
  const { data: target } = await supa().from('admins').select('*').eq('id', req.params.id).maybeSingle();
  if (!target) return res.status(404).json({ error: 'Admin not found' });
  const { username, password, role } = req.body || {};
  const name = username != null ? String(username).trim() : null;
  if (name && name !== target.username) {
    const { data: dup } = await supa().from('admins').select('id').eq('username', name).maybeSingle();
    if (dup) return res.status(409).json({ error: 'That username is already taken' });
  }
  if (password != null && password !== '' && String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const nextRole = role != null ? (role === 'ADMIN' ? 'ADMIN' : 'STAFF') : (target.role || 'ADMIN');
  const { count: adminCount } = await supa().from('admins').select('*', { count: 'exact', head: true }).eq('role', 'ADMIN');
  if ((target.role || 'ADMIN') === 'ADMIN' && nextRole !== 'ADMIN' && (adminCount || 0) <= 1) {
    return res.status(400).json({ error: 'Cannot remove the last admin account' });
  }
  const upd: Record<string, any> = { role: nextRole };
  if (name) upd.username = name;
  if (password != null && password !== '') upd.password_hash = bcrypt.hashSync(password, 10);
  await supa().from('admins').update(upd).eq('id', req.params.id);
  res.json({ ok: true });
});

r.delete('/admins/:id', requireAdmin, async (req, res) => {
  const { data: target } = await supa().from('admins').select('*').eq('id', req.params.id).maybeSingle();
  if (!target) return res.status(404).json({ error: 'Admin not found' });
  if (Number((req as any).admin?.sub) === target.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }
  if ((target.role || 'ADMIN') === 'ADMIN') {
    const { count: adminCount } = await supa().from('admins').select('*', { count: 'exact', head: true }).eq('role', 'ADMIN');
    if ((adminCount || 0) <= 1) return res.status(400).json({ error: 'Cannot remove the last admin account' });
  }
  await supa().from('admins').delete().eq('id', req.params.id);
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
  const { data } = await supa().from('app_settings').select('key, value');
  const settings: Record<string, string> = {};
  for (const row of data || []) settings[row.key] = row.value;
  res.json(settings);
});

r.put('/settings/:key', async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;
  if (value == null) return res.status(400).json({ error: 'Missing value' });
  const now = new Date().toISOString();
  // Upsert: try update first, then insert if row doesn't exist
  const { data: existing } = await supa().from('app_settings').select('key').eq('key', key).maybeSingle();
  if (existing) {
    await supa().from('app_settings').update({ value: String(value), updated_at: now }).eq('key', key);
  } else {
    await supa().from('app_settings').insert({ key, value: String(value), updated_at: now });
  }
  res.json({ ok: true });
});

export default r;