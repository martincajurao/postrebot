﻿﻿import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { supa } from '../db/supabase';
import { authMiddleware, requireRole, verifyWebviewPsid, rememberAdminForPsid, getRememberedAdmin, forgetRememberedAdmin, issueAdminToken } from './auth';
import { updateOrderStatus, updatePaymentStatus, getOrderItems } from '../services/orders';
import { getVapidPublicKey, storeSubscription, removeSubscription, sendPushToAdmins, getPushStatus } from '../services/push';
import {
  createReservation, cancelReservation, updateReservationStatus,
  rescheduleReservation, slotAvailability, isDateOpen,
  syncReservationFromOrder, syncOrderFromReservation, ensureReservationFromOrder,
} from '../services/reservations';
import { choiceUpgrade, computeCartTotals, packageDefaults, priceProduct } from '../services/pricing';
import { getStoreInfo, STORE_INFO_KEYS, invalidateStoreInfoCache } from '../services/store-info';
import { getBranches, saveBranches, parseBranches, serializeBranches, getBranchCoords, saveBranchCoords } from '../services/branches';
import { notifyOrderStatus, sendRatingRequest, sendText, sendQuickReplies } from '../messenger/send';

const r = Router();

// Destructive admin-only operations (permanent delete / reset) — declared here
// so the DELETE routes below can reference it at registration time.
const requireAdmin = requireRole('ADMIN');

// ---- Messenger webview "remembered login" (public — HMAC-signed psid guard) ----
// The bot opens /admin with psid+ts+sig signed with JWT_SECRET. An admin who
// logged in once from the webview stays remembered for 30 days (sliding), so
// the next "admin2020" opens straight into the dashboard with no login prompt.
r.get('/remembered', async (req, res) => {
  try {
    const { psid, ts, sig } = req.query as Record<string, string>;
    if (!psid || !ts || !sig || !verifyWebviewPsid(String(psid), String(ts), String(sig))) {
      return res.status(401).json({ error: 'Invalid or expired webview signature' });
    }
    const remembered = await getRememberedAdmin(String(psid));
    if (!remembered) return res.status(404).json({ error: 'No remembered session — please log in once' });
    const token = issueAdminToken({ id: remembered.admin_id, username: remembered.username, role: remembered.role });
    await rememberAdminForPsid(String(psid), remembered); // slide the 30-day window
    console.log(`[admin] webview remembered login: psid=${psid} user=${remembered.username}`);
    return res.json({ token, id: remembered.admin_id, username: remembered.username, role: remembered.role });
  } catch (e: any) {
    console.error('[admin] /remembered error:', e?.message || e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

r.post('/remembered/forget', async (req, res) => {
  try {
    const { psid, ts, sig } = req.query as Record<string, string>;
    if (!psid || !ts || !sig || !verifyWebviewPsid(String(psid), String(ts), String(sig))) {
      return res.status(401).json({ error: 'Invalid or expired webview signature' });
    }
    await forgetRememberedAdmin(String(psid));
    console.log(`[admin] webview remembered session forgotten: psid=${psid}`);
    return res.json({ ok: true });
  } catch (e: any) {
    console.error('[admin] /remembered/forget error:', e?.message || e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

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
  const { name, active, sort_order } = req.body;
  const upd: Record<string, any> = {};
  if (name != null) upd.name = name;
  if (active != null) upd.active = active;
  if (sort_order != null) upd.sort_order = sort_order;
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
  res.json(products.map((p: any) => ({
    ...p,
    variants: variants.filter((v: any) => v.product_id === p.id),
    branches: parseBranches(p.branches),
  })));
});
r.post('/products', async (req, res) => {
  const { category_id, name, description, photo_url, variants = [], branches } = req.body;
  const { data: prodRow, error: prodErr } = await supa().from('products')
    .insert({ category_id, name, description: description ?? null, photo_url: photo_url ?? null, branches: serializeBranches(branches) })
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
  const { name, description, photo_url, category_id, active, unavailable, branches } = req.body;
  const upd: Record<string, any> = {};
  if (name != null) upd.name = name;
  if (description != null) upd.description = description;
  if (photo_url != null) upd.photo_url = photo_url;
  if (category_id != null) upd.category_id = category_id;
  if (active != null) upd.active = active;
  if (unavailable != null) upd.unavailable = unavailable;
  if (branches != null) upd.branches = serializeBranches(branches);
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
    branches: parseBranches(p.branches),
    slots: slots.filter((s: any) => s.package_id === p.id).map((s: any) => ({
      ...s,
      options: opts.filter((o: any) => o.slot_id === s.id),
    })),
  })));
});
r.post('/packages', async (req, res) => {
  const { name, description, photo_url, base_price, selections, discount = 0, is_fixed = 0, is_custom = 0, branches } = req.body;
  const { data, error } = await supa().from('packages')
    .insert({ name, description: description ?? null, photo_url: photo_url ?? null, base_price, selections, discount, is_fixed, is_custom, branches: serializeBranches(branches) })
    .select('id').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ id: Number(data.id) });
});
r.put('/packages/:id', async (req, res) => {
  const { name, description, photo_url, base_price, selections, active, discount, is_fixed, is_custom, branches } = req.body;
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
  if (branches != null) upd.branches = serializeBranches(branches);
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
  res.json((data || []).map((fp: any) => ({ ...fp, branches: parseBranches(fp.branches) })));
});
r.post('/food-packs', async (req, res) => {
  const { name, description, photo_url, price, serves, sort_order = 0, active = 1, branches } = req.body;
  if (!name || price == null) return res.status(400).json({ error: 'name and price are required' });
  const { data, error } = await supa().from('food_packs')
    .insert({ name, description: description ?? null, photo_url: photo_url ?? null, price, serves: serves ?? null, sort_order, active, branches: serializeBranches(branches) })
    .select('id').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ id: Number(data.id) });
});
r.put('/food-packs/:id', async (req, res) => {
  const { name, description, photo_url, price, serves, sort_order, active, branches } = req.body;
  const upd: Record<string, any> = {};
  if (name != null) upd.name = name;
  if (description != null) upd.description = description;
  if (photo_url != null) upd.photo_url = photo_url;
  if (price != null) upd.price = price;
  if (serves != null) upd.serves = serves;
  if (sort_order != null) upd.sort_order = sort_order;
  if (active != null) upd.active = active;
  if (branches != null) upd.branches = serializeBranches(branches);
  if (Object.keys(upd).length > 0) await supa().from('food_packs').update(upd).eq('id', req.params.id);
  res.json({ ok: true });
});
r.delete('/food-packs/:id', async (req, res) => {
  await supa().from('food_packs').update({ active: 0 }).eq('id', req.params.id);
  res.json({ ok: true });
});

// ---- Orders ----
r.get('/orders', async (_req, res) => {
  const { data } = await supa().from('orders').select('*, customers(name, phone)').order('id', { ascending: false });
  const orders = data || [];
  // Populate the Items column in one batched query (items + their package slots).
  const ids = orders.map((o: any) => o.id);
  const itemsByOrder = new Map<number, any[]>();
  if (ids.length) {
    const { data: items } = await supa().from('order_items')
      .select('order_id, name, variant_size, quantity, order_package_items(product_name, upgrade_price, slot_number)')
      .in('order_id', ids);
    for (const it of items || []) {
      const list = itemsByOrder.get(Number(it.order_id)) || [];
      list.push({
        name: it.name,
        variant_size: it.variant_size,
        quantity: it.quantity,
        package_items: (it as any).order_package_items || [],
      });
      itemsByOrder.set(Number(it.order_id), list);
    }
  }
  // Order and reservation are ONE entity: every order stays visible here with
  // the full pipeline (advance / payment / rider / discount); the Reservations
  // page shows the same entity as its schedule entry.
  res.json(orders.map((o: any) => ({
    ...o,
    items: itemsByOrder.get(Number(o.id)) || [],
    customer_name: o.customers?.name ?? null,
    phone: o.phone ?? o.customers?.phone ?? null,
    customers: undefined,
  })));
});
r.get('/orders/:id', async (req, res) => {
  const { data: order } = await supa().from('orders').select('*, customers(name, phone)').eq('id', req.params.id).maybeSingle();
  if (!order) return res.status(404).json({ error: 'Order not found' });
  // additional_discount may not exist on DBs created before that column was
  // added — default to 0 so the edit modal never breaks.
  if (order.additional_discount === undefined) order.additional_discount = 0;
  const [itemsRes, pkgRes, histRes] = await Promise.all([
    supa().from('order_items').select('*').eq('order_id', order.id),
    supa().from('order_package_items').select('*').order('order_item_id, slot_number'),
    supa().from('order_status_history').select('*').eq('order_id', order.id).order('created_at'),
  ]);
  const items = itemsRes.data || [];
  const packageItems = pkgRes.data || [];

  // For existing orders without a stored package discount (legacy rows saved
  // with discount 0/NULL), calculate from package info so the edit modal can
  // show the net line price (e.g. C1 gross 3100 − 800 = 2300, not 3100).
  const db = supa();
  for (const item of items) {
    if (item.package_id && !(Number(item.discount) > 0)) {
      // Calculate discount from package
      const { data: pkg } = await db.from('packages').select('is_custom, discount').eq('id', item.package_id).maybeSingle();
      if (pkg?.is_custom) {
        // Custom package: calculate tiered volume discount
        const { data: pkgItems } = await db.from('order_package_items').select('product_id').eq('order_item_id', item.id);
        let itemsSum = 0;
        for (const pi of pkgItems || []) {
          itemsSum += await menuPriceM(Number(pi.product_id));
        }
        item.discount = autoDiscount(itemsSum);
      } else if (pkg) {
        // Fixed package: admin-set discount per unit
        item.discount = Number(pkg.discount || 0);
      } else {
        item.discount = 0;
      }
    } else if (!item.package_id) {
      item.discount = 0;
    }
  }

  order.items = items.map((i: any) => ({
    ...i,
    package_items: packageItems.filter((pi: any) => pi.order_item_id === i.id),
  }));
  order.status_history = histRes.data || [];
  order.customer_name = (order as any).customers?.name ?? null;
  order.customer_phone = (order as any).customers?.phone ?? null;
  (order as any).customers = undefined;
  res.json(order);
});
r.post('/orders/:id/status', async (req, res) => {
  const { status } = req.body;
  const { data: order } = await supa().from('orders').select('*, customers(name, phone)').eq('id', req.params.id).maybeSingle();
  if (!order) return res.status(404).json({ error: 'Order not found' });
  await updateOrderStatus(order.id, status);

  // One sync path: mirror the order lifecycle onto its linked reservation
  // (CONFIRMED/PREPARING/READY → CONFIRMED, COMPLETED → COMPLETED, CANCELLED → CANCELLED).
  await syncReservationFromOrder(order.id);

  if (order.customer_id) {
    const customer = await supa().from('customers').select('psid').eq('id', order.customer_id).maybeSingle();
    if (customer?.data?.psid) {
            if (status === 'READY') {
        // Combine on-the-way message with quick replies for order completion (single message)
        await sendQuickReplies(customer.data.psid, `Your order${order.order_number ? ` (${order.order_number})` : ''} has been picked up by our delivery rider and is now on its way! Tap below when you receive it:`, [
          { title: '✅ Order Received', payload: `COMPLETE:${order.id}` },
          { title: '🏠 Main Menu', payload: 'MAIN_MENU' },
        ]);
      }
      else await notifyOrderStatus(customer.data.psid, status, order.order_number, order);
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
  const { data: order } = await supa().from('orders').select('*, customers(name, phone)').eq('id', req.params.id).maybeSingle();
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'PENDING') return res.status(400).json({ error: 'Only pending orders can be confirmed' });
  // The stored total already has the package discounts deducted at order time
  // (total = subtotal − discount). Confirming just adds the admin-set delivery
  // fee and re-applies any additional deduction.
  const newTotal = Math.max(0, (Number(order.total) || 0) + fee - (Number(order.additional_discount) || 0));
  await supa().from('orders').update({ status: 'CONFIRMED', delivery_fee: fee, total: newTotal }).eq('id', order.id);
  await supa().from('order_status_history').insert({ order_id: order.id, status: 'CONFIRMED' });

  // One sync path: mirror CONFIRMED onto the linked reservation (creates it if missing).
  await syncReservationFromOrder(order.id);

  if (order.customer_id) {
    const customer = await supa().from('customers').select('psid').eq('id', order.customer_id).maybeSingle();
    if (customer?.data?.psid) {
      await notifyOrderStatus(customer.data.psid, 'CONFIRMED', order.order_number, order);
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

// ---- Orders: admin edit (customer change of mind) ----
// Active orders only — CANCELLED / COMPLETED orders are historical records.
function orderEditBlocked(order: any): string | null {
  if (order.status === 'CANCELLED' || order.status === 'COMPLETED') {
    return `A ${String(order.status).toLowerCase()} order can no longer be edited`;
  }
  return null;
}

/** M-size menu price of a dish (cheapest variant as fallback). */
async function menuPriceM(productId: number): Promise<number> {
  const { data: variants } = await supa().from('product_variants').select('size, price').eq('product_id', productId);
  const m = variants?.find((v: any) => String(v.size).toUpperCase() === 'M') || (variants && variants[0]);
  return Number(m?.price) || 0;
}

/**
 * Auto-discount for "Build Your Own" custom packages, based on the sum of the
 * selected dishes' M-size menu prices: sum >= 5000 → 1100, >= 4300 → 1000,
 * >= 3000 → 700, else 0. Mirrors pricing.ts:autoDiscount().
 */
function autoDiscount(itemsSum: number): number {
  if (itemsSum >= 5000) return 1100;
  if (itemsSum >= 4300) return 1000;
  if (itemsSum >= 3000) return 700;
  return 0;
}

/** Recompute subtotal/total after an item quantity change or removal.
 *  Stored pipeline: total = subtotal − packageDiscounts + delivery_fee − additional_discount.
 *  Package discounts are recalculated from the actual items (not scaled proportionally)
 * because custom "Build Your Own" packages use a tiered volume discount that is a
 * step function of the dish sum, not a flat rate — scaling it gives the wrong answer
 * when a non-package item is added/removed or the quantity changes. */
async function recalcOrderTotalsAfterItemEdit(orderId: number): Promise<{ subtotal: number; total: number; savings: number }> {
  const db = supa();
  // additional_discount may not exist yet on older DBs — fall back to 0.
  let order: any = null;
  {
    const r = await db.from('orders').select('subtotal, total, delivery_fee, additional_discount').eq('id', orderId).maybeSingle();
    if (!r.error) order = r.data;
    else order = (await db.from('orders').select('subtotal, total, delivery_fee').eq('id', orderId).maybeSingle()).data;
  }
  if (!order) throw new Error('Order not found');
  const { data: items } = await db.from('order_items').select('*').eq('order_id', orderId);

  // Subtotal = sum of GROSS line totals (unit_price is stored gross).
  const newSubtotal = (items || []).reduce((s: number, it: any) => s + (Number(it.unit_price) || 0) * (Number(it.quantity) || 0), 0);

  // Recalculate every package discount from the actual dishes so the tiered
  // auto-discount for custom packages is always correct.
  let packageDiscounts = 0;
  for (const it of items || []) {
    if (!it.package_id) continue;
    const { data: pkg } = await db.from('packages').select('is_custom, discount').eq('id', it.package_id).maybeSingle();
    if (pkg?.is_custom) {
      // Custom package: sum the M-menu prices of the chosen dishes.
      const { data: pkgItems } = await db.from('order_package_items').select('product_id').eq('order_item_id', it.id);
      let itemsSum = 0;
      for (const pi of pkgItems || []) {
        itemsSum += await menuPriceM(Number(pi.product_id));
      }
      packageDiscounts += autoDiscount(itemsSum) * Number(it.quantity);
    } else {
      // Fixed package: admin-set discount per unit.
      packageDiscounts += Number(pkg?.discount || 0) * Number(it.quantity);
    }
  }

  const newTotal = Math.max(0, newSubtotal - packageDiscounts + (Number(order.delivery_fee) || 0) - (Number(order.additional_discount) || 0));
  await db.from('orders').update({ subtotal: newSubtotal, total: newTotal }).eq('id', orderId);
  return { subtotal: newSubtotal, total: newTotal, savings: packageDiscounts };
}

/** Best-effort Messenger summary of what the admin changed for the customer. */
async function notifyOrderEdited(order: any, changes: string[]): Promise<void> {
  if (!changes.length) return;
  try {
    const { data: cust } = await supa().from('customers').select('psid').eq('id', order.customer_id).maybeSingle();
    if (cust?.psid) await sendText(cust.psid, `✏️ Update for your order (${order.order_number}):\n${changes.join('\n')}`);
  } catch { /* notification is best effort */ }
}

// Edit order details — type, contact, address, schedule, notes. The linked
// reservation (ONE entity) is kept in sync, a missing reservation is created
// when the order is scheduled, and the customer is told what changed.
r.put('/orders/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { order_type, address, phone, notes, fulfillment_date, time_slot } = req.body || {};
  const { data: order } = await supa().from('orders').select('*').eq('id', id).maybeSingle();
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const blocked = orderEditBlocked(order);
  if (blocked) return res.status(400).json({ error: blocked });
  if (order_type != null && !['delivery', 'pickup'].includes(order_type)) return res.status(400).json({ error: 'Invalid order type' });

  const upd: Record<string, any> = {};
  if (order_type != null) upd.order_type = order_type;
  if (address != null) upd.address = String(address).trim() || null;
  if (notes != null) upd.notes = String(notes).trim() || null;

  let newDate: string | null = null;
  let newSlot: string | null = null;
  // Treat empty strings as "not provided" — only validate when both are meaningfully set.
  const hasDate = fulfillment_date != null && String(fulfillment_date).trim() !== '';
  const hasSlot = time_slot != null && String(time_slot).trim() !== '';
  if (hasDate || hasSlot) {
    newDate = hasDate ? String(fulfillment_date).trim() : order.fulfillment_date;
    newSlot = hasSlot ? String(time_slot).trim() : order.time_slot;
    if (!newDate || !newSlot) return res.status(400).json({ error: 'Both a date and a time slot are required' });
    const { data: slotData } = await supa().from('time_slots').select('*').eq('label', newSlot).eq('active', 1).maybeSingle();
    if (!slotData) return res.status(400).json({ error: 'Invalid time slot' });
    // Capacity check excluding this order's own reservation, so re-booking the
    // same slot (or only moving the date) is never blocked by itself.
    const { data: ownResv } = await supa().from('reservations').select('id').eq('order_id', id).maybeSingle();
    const { count } = await supa().from('reservations').select('*', { count: 'exact', head: true })
      .eq('res_date', newDate).eq('time_slot', newSlot).neq('status', 'CANCELLED');
    const used = (count || 0) - (ownResv ? 1 : 0);
    if (used >= (Number(slotData.max_capacity) || 0)) return res.status(400).json({ error: 'Time slot is full' });
    upd.fulfillment_date = newDate;
    upd.time_slot = newSlot;
  }

  if (Object.keys(upd).length === 0 && (phone == null || !String(phone).trim())) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  await supa().from('orders').update(upd).eq('id', id);

  // Mirror onto the linked reservation; create one when the order is scheduled
  // but had no reservation yet.
  const { data: resv } = await supa().from('reservations').select('id').eq('order_id', id).maybeSingle();
  if (resv) {
    const resvUpd: Record<string, any> = {};
    if (upd.fulfillment_date != null) resvUpd.res_date = upd.fulfillment_date;
    if (upd.time_slot != null) resvUpd.time_slot = upd.time_slot;
    if (upd.notes != null) resvUpd.notes = upd.notes;
    if (Object.keys(resvUpd).length > 0) await supa().from('reservations').update(resvUpd).eq('id', resv.id);
  } else if (upd.fulfillment_date && upd.time_slot) {
    const { data: fresh } = await supa().from('orders').select('*').eq('id', id).maybeSingle();
    if (fresh) await ensureReservationFromOrder(fresh);
  }
  await syncReservationFromOrder(id);

  // Remember new contact details on the customer record for future checkouts.
  if (phone != null && String(phone).trim()) {
    await supa().from('customers').update({ phone: String(phone).trim() }).eq('id', order.customer_id);
  }

  const changes: string[] = [];
  if (upd.order_type && upd.order_type !== order.order_type) changes.push(`Type: ${upd.order_type === 'delivery' ? '🚚 Delivery' : '🏬 Pickup'}`);
  if (upd.fulfillment_date && upd.fulfillment_date !== order.fulfillment_date) changes.push(`📅 Date: ${upd.fulfillment_date}`);
  if (upd.time_slot && upd.time_slot !== order.time_slot) changes.push(`⏰ Time: ${upd.time_slot}`);
  if (upd.address !== undefined && upd.address !== order.address) changes.push(`📍 Address: ${upd.address || '—'}`);
  if (upd.notes !== undefined && upd.notes !== order.notes) changes.push('📝 Notes updated');
  await notifyOrderEdited(order, changes);

  res.json({ ok: true });
});

// Add an item to the order (customer changed their mind — "add one more").
// Priced server-side from the DB — same pricing path as checkout: products by
// variant, packages by their default (★) slot dishes, food packs by price.
r.post('/orders/:id/items', async (req, res) => {
  const orderId = Number(req.params.id);
  const { product_id, package_id, food_pack_id, variant_size, quantity } = req.body || {};
  const qty = Math.floor(Number(quantity));
  if (!qty || qty < 1 || qty > 99) return res.status(400).json({ error: 'Quantity must be between 1 and 99' });
  const { data: order } = await supa().from('orders').select('status').eq('id', orderId).maybeSingle();
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const blocked = orderEditBlocked(order);
  if (blocked) return res.status(400).json({ error: blocked });

  const size = variant_size ? String(variant_size).trim().toUpperCase() : undefined;
  const cartLine: any = { quantity: qty };
  let name = '';
  if (product_id) {
    cartLine.product_id = Number(product_id);
    if (size) cartLine.variant_size = size;
    const { data: prod } = await supa().from('products').select('name').eq('id', product_id).maybeSingle();
    if (!prod) return res.status(400).json({ error: 'Product not found' });
    name = prod.name + (size ? ` (${size})` : '');
  } else if (package_id) {
    cartLine.package_id = Number(package_id);
    if (size) cartLine.variant_size = size;
    const { data: pkg } = await supa().from('packages').select('name').eq('id', package_id).maybeSingle();
    if (!pkg) return res.status(400).json({ error: 'Package not found' });
    cartLine.slot_choices = await packageDefaults(Number(package_id));
    name = pkg.name + (size ? ` (${size})` : '');
  } else if (food_pack_id) {
    cartLine.food_pack_id = Number(food_pack_id);
    const { data: fp } = await supa().from('food_packs').select('name').eq('id', food_pack_id).maybeSingle();
    if (!fp) return res.status(400).json({ error: 'Food pack not found' });
    name = fp.name + ' (food pack)';
  } else {
    return res.status(400).json({ error: 'Pick an item to add' });
  }

  try {
    const line = await computeCartTotals([cartLine], 0);
    if (!line.subtotal) throw new Error('This item has no price set — set its price in the Menu first');
    const unit = Math.round(line.subtotal / qty);
    const unitDiscount = Math.round((line.discount || 0) / Math.max(1, qty));
    const { data: itemRow, error: itemErr } = await supa().from('order_items').insert({
      order_id: orderId,
      product_id: cartLine.product_id ?? null,
      package_id: cartLine.package_id ?? null,
      food_pack_id: cartLine.food_pack_id ?? null,
      name,
      variant_size: cartLine.variant_size ?? null,
      quantity: qty,
      unit_price: unit,
      line_total: line.subtotal,
      discount: unitDiscount,
    }).select('id').single();
    if (itemErr) throw new Error(itemErr.message);
    const itemId = Number(itemRow.id);
    // Remember the package's chosen dishes on the line (slot contents), the
    // same way checkout records them.
    if (cartLine.package_id && Array.isArray(cartLine.slot_choices)) {
      for (const c of cartLine.slot_choices) {
        const { data: prod } = await supa().from('products').select('name').eq('id', c.product_id).maybeSingle();
        let extra = 0;
        try { extra = await choiceUpgrade(cartLine.package_id, c.slot_number, c.product_id, cartLine.variant_size); } catch { extra = 0; }
        await supa().from('order_package_items').insert({
          order_item_id: itemId,
          slot_number: c.slot_number,
          product_id: c.product_id,
          product_name: prod?.name ?? 'Unknown',
          upgrade_price: extra,
        });
      }
    }
    const totals = await recalcOrderTotalsAfterItemEdit(orderId);
    res.json({ ok: true, item_id: itemId, ...totals });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Change an item's quantity / size (customer wants more, fewer, or M→L).
r.put('/orders/:id/items/:itemId', async (req, res) => {
  const orderId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const { data: order } = await supa().from('orders').select('status').eq('id', orderId).maybeSingle();
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const blocked = orderEditBlocked(order);
  if (blocked) return res.status(400).json({ error: blocked });
  const { data: item } = await supa().from('order_items').select('id, product_id, unit_price, quantity, variant_size').eq('id', itemId).eq('order_id', orderId).maybeSingle();
  if (!item) return res.status(404).json({ error: 'Order item not found' });

  // Size change (M/L) on a plain product line — re-priced from the menu.
  let unitPrice = Number(item.unit_price) || 0;
  let variantSize: string | null = item.variant_size;
  if (req.body?.variant_size !== undefined && item.product_id) {
    const nextSize = String(req.body.variant_size).trim().toUpperCase() || null;
    if (nextSize !== (item.variant_size || null)) {
      try {
        unitPrice = await priceProduct(Number(item.product_id), nextSize || undefined);
      } catch (e: any) {
        return res.status(400).json({ error: e.message });
      }
      variantSize = nextSize;
    }
  }

  const quantity = req.body?.quantity !== undefined
    ? Math.floor(Number(req.body.quantity))
    : Number(item.quantity);
  if (!quantity || quantity < 1 || quantity > 99) return res.status(400).json({ error: 'Quantity must be between 1 and 99' });

  const changed = quantity !== Number(item.quantity) || unitPrice !== (Number(item.unit_price) || 0) || variantSize !== item.variant_size;
  if (changed) {
    await supa().from('order_items').update({
      quantity,
      unit_price: unitPrice,
      line_total: Math.round(unitPrice * quantity),
      ...(variantSize !== item.variant_size ? { variant_size: variantSize } : {}),
    }).eq('id', itemId);
  }
  const totals = await recalcOrderTotalsAfterItemEdit(orderId);
  res.json({ ok: true, ...totals });
});

// Remove an item the customer no longer wants.
r.delete('/orders/:id/items/:itemId', async (req, res) => {
  const orderId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const { data: order } = await supa().from('orders').select('status').eq('id', orderId).maybeSingle();
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const blocked = orderEditBlocked(order);
  if (blocked) return res.status(400).json({ error: blocked });
  const { data: item } = await supa().from('order_items').select('id').eq('id', itemId).eq('order_id', orderId).maybeSingle();
  if (!item) return res.status(404).json({ error: 'Order item not found' });
  const { count } = await supa().from('order_items').select('*', { count: 'exact', head: true }).eq('order_id', orderId);
  if ((count || 0) <= 1) return res.status(400).json({ error: 'An order must keep at least one item — cancel the order instead' });
  await supa().from('order_package_items').delete().eq('order_item_id', itemId);
  await supa().from('order_items').delete().eq('id', itemId);
  const totals = await recalcOrderTotalsAfterItemEdit(orderId);
  res.json({ ok: true, ...totals });
});

// ---- Orders: permanent delete / reset (ADMIN only) ----
// Delete one order and everything attached to it (items, package items, status
// history, ratings) plus any reservation derived from it.
r.delete('/orders/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid order ID' });
    await supa().from('reservations').delete().eq('order_id', id);
    const { data: items } = await supa().from('order_items').select('id').eq('order_id', id);
    const itemIds = (items || []).map((i: any) => Number(i.id));
    if (itemIds.length) {
      await supa().from('order_package_items').delete().in('order_item_id', itemIds);
    }
    await supa().from('order_items').delete().eq('order_id', id);
    await supa().from('order_status_history').delete().eq('order_id', id);
    await supa().from('order_ratings').delete().eq('order_id', id);
    await supa().from('orders').delete().eq('id', id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Reset orders: permanently clear ALL orders and their child rows + linked reservations.
r.delete('/orders', requireAdmin, async (_req, res) => {
  try {
    const { data: items } = await supa().from('order_items').select('id');
    const itemIds = (items || []).map((i: any) => Number(i.id));
    if (itemIds.length) {
      await supa().from('order_package_items').delete().in('order_item_id', itemIds);
    }
    await supa().from('order_items').delete().gte('id', 0);
    await supa().from('order_status_history').delete().gte('id', 0);
    await supa().from('order_ratings').delete().gte('id', 0);
    await supa().from('reservations').delete().gte('id', 0);
    await supa().from('orders').delete().gte('id', 0);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
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
// NOTE: must be registered BEFORE '/reservations/:id' so 'availability'
// isn't captured as an :id parameter.
r.get('/reservations/availability', async (req, res) => {
  const date = String(req.query.date || '');
  if (!date) return res.status(400).json({ error: 'date is required' });
  const open = await isDateOpen(date);
  if (!open.open) return res.json({ open: false, reason: open.reason, slots: [] });
  res.json({ open: true, slots: await slotAvailability(date) });
});
r.get('/reservations', async (req, res) => {
  const date = String(req.query.date || '');
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  const status = String(req.query.status || '');
  const slot = String(req.query.slot || '');
  const search = String(req.query.q || '').trim();
  const withCancelled = String(req.query.include_cancelled || '') === '1';

  let query = supa().from('reservations').select('*, order:orders(id, status, total, payment_status, order_type)');
  if (!withCancelled) query = query.neq('status', 'CANCELLED');
  if (date) {
    query = query.eq('res_date', date);
  } else {
    if (from) query = query.gte('res_date', from);
    if (to) query = query.lte('res_date', to);
  }
  if (status) {
    // support comma-separated statuses, e.g. ?status=PENDING,CONFIRMED
    const statuses = status.split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.length === 1) query = query.eq('status', statuses[0]);
    else if (statuses.length > 1) query = query.in('status', statuses);
  }
  if (slot) query = query.eq('time_slot', slot);
  if (search) query = query.or(`customer_name.ilike.%${search}%,phone.ilike.%${search}%`);

  const { data, error } = await query
    .order('res_date', { ascending: !!from || !!to ? true : false })
    .order('time_slot');
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});
r.get('/reservations/:id', async (req, res) => {
  const { data: reservation } = await supa().from('reservations').select('*').eq('id', req.params.id).maybeSingle();
  if (!reservation) return res.status(404).json({ error: 'Reservation not found' });

  // If linked to an order, fetch its summary + items
  if (reservation.order_id) {
    const [{ data: order }, items] = await Promise.all([
      supa().from('orders').select('id, status, total, payment_status, order_type').eq('id', reservation.order_id).maybeSingle(),
      getOrderItems(reservation.order_id),
    ]);
    reservation.order = order || null;
    reservation.order_items = items;
  }

  res.json(reservation);
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
  const id = Number(req.params.id);
  await cancelReservation(id);
  // Mirror the cancellation onto the linked order so it also leaves the
  // Orders pipeline and frees its time slot everywhere.
  const { data: resv } = await supa().from('reservations').select('order_id').eq('id', id).maybeSingle();
  if (resv?.order_id) {
    const sync = await syncOrderFromReservation(Number(resv.order_id), 'CANCELLED');
    if (sync.changed && sync.status) {
      const { data: ord } = await supa().from('orders').select('order_number, customer_id').eq('id', Number(resv.order_id)).maybeSingle();
      if (ord?.customer_id) {
        const { data: cust } = await supa().from('customers').select('psid').eq('id', ord.customer_id).maybeSingle();
        if (cust?.psid) await notifyOrderStatus(cust.psid, sync.status, ord.order_number);
      }
    }
    return res.json({ ok: true, order_status: sync.status ?? null });
  }
  res.json({ ok: true });
});
r.post('/reservations/:id/status', async (req, res) => {
  const { status } = req.body;
  const id = Number(req.params.id);
  await updateReservationStatus(id, status);
  // Mirror onto the linked order (escalation only) so both views stay in step.
  const { data: resv } = await supa().from('reservations').select('order_id').eq('id', id).maybeSingle();
  if (resv?.order_id) {
    const sync = await syncOrderFromReservation(Number(resv.order_id), String(status));
    if (sync.changed && sync.status) {
      const { data: ord } = await supa().from('orders').select('order_number, customer_id').eq('id', Number(resv.order_id)).maybeSingle();
      if (ord?.customer_id) {
        const { data: cust } = await supa().from('customers').select('psid').eq('id', ord.customer_id).maybeSingle();
        if (cust?.psid) await notifyOrderStatus(cust.psid, sync.status, ord.order_number);
      }
    }
    return res.json({ ok: true, order_status: sync.status ?? null });
  }
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

// Edit a reservation (customer change of mind): name, phone, notes, schedule.
// Schedule + notes mirror onto the linked order — ONE entity.
r.put('/reservations/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { customer_name, phone, notes, res_date, time_slot } = req.body || {};
  const { data: resv } = await supa().from('reservations').select('*').eq('id', id).maybeSingle();
  if (!resv) return res.status(404).json({ error: 'Reservation not found' });
  if (resv.status === 'CANCELLED' || resv.status === 'COMPLETED') {
    return res.status(400).json({ error: `A ${String(resv.status).toLowerCase()} reservation can no longer be edited` });
  }

  const upd: Record<string, any> = {};
  if (customer_name != null && String(customer_name).trim()) upd.customer_name = String(customer_name).trim();
  if (phone != null) upd.phone = String(phone).trim() || null;
  if (notes != null) upd.notes = String(notes).trim() || null;

  let newDate: string | null = null;
  let newSlot: string | null = null;
  if (res_date != null || time_slot != null) {
    newDate = res_date != null ? res_date : resv.res_date;
    newSlot = time_slot != null ? time_slot : resv.time_slot;
    if (!newDate || !newSlot) return res.status(400).json({ error: 'Both a date and a time slot are required' });
    try {
      await rescheduleReservation(id, newDate, newSlot); // validates the slot + capacity (excluding itself)
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }
  }

  if (Object.keys(upd).length > 0) await supa().from('reservations').update(upd).eq('id', id);

  // Mirror schedule + notes onto the linked order.
  if (resv.order_id) {
    const ordUpd: Record<string, any> = {};
    if (newDate && newSlot) { ordUpd.fulfillment_date = newDate; ordUpd.time_slot = newSlot; }
    if (upd.notes != null) ordUpd.notes = upd.notes;
    if (Object.keys(ordUpd).length > 0) await supa().from('orders').update(ordUpd).eq('id', resv.order_id);
  }

  res.json({ ok: true });
});

// ---- Reservations: permanent delete / reset (ADMIN only) ----
r.delete('/reservations/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid reservation ID' });
    await supa().from('reservations').delete().eq('id', id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Reset reservations: permanently clear ALL reservations (linked orders are kept).
r.delete('/reservations', requireAdmin, async (_req, res) => {
  try {
    await supa().from('reservations').delete().gte('id', 0);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
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

// ---- Store info (payment + contact shown to customers) ----
// Stored in app_settings (editable live in Admin → Settings → 💳 Payment & Contact);
// the PAYMENT_*/CONTACT_* env vars remain the defaults. The Messenger bot and the
// webview /config read these (short in-process cache, invalidated on save).
r.get('/store-info', async (_req, res) => {
  try {
    res.json(await getStoreInfo());
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

r.put('/store-info', async (req, res) => {
  try {
    const body = req.body || {};
    const updates = STORE_INFO_KEYS.filter((k) => typeof body[k] === 'string');
    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    const now = new Date().toISOString();
    for (const key of updates) {
      const value = String(body[key]).slice(0, 300);
      const { data: existing } = await supa().from('app_settings').select('key').eq('key', key).maybeSingle();
      if (existing) await supa().from('app_settings').update({ value, updated_at: now }).eq('key', key);
      else await supa().from('app_settings').insert({ key, value, updated_at: now });
    }
    invalidateStoreInfoCache();
    res.json({ ok: true, updated: updates });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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

// ---- Branches / Locations (availability list used by Menu & Packages) ----

r.get('/branches', async (_req, res) => {
  const branches = await getBranches();
  const coords = await getBranchCoords();
  res.json({ branches, coords });
});

r.put('/branches', async (req, res) => {
  try {
    const branches = await saveBranches(req.body?.branches);
    if (req.body?.coords != null) {
      await saveBranchCoords(req.body.coords);
    }
    const coords = await getBranchCoords();
    res.json({ ok: true, branches, coords });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default r;