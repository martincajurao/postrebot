/**
 * Webview API - REST endpoints that mirror the Messenger bot's ordering flow.
 * A session ID (stored in the browser) replaces the Messenger PSID.
 * Uses Supabase query builder — no raw SQL.
 * Full CRUD support for Cart, Orders, and Catalog resources.
 */

import { Router, Request, Response } from 'express';
import { supa } from '../db/supabase';
import { getCart, addItem, removeItem, updateQuantity, cartTotals, clearCart } from '../services/cart';
import { createOrderFromCart, getCustomerOrders, getOrderById, getOrderItems, cancelOrder, updateOrderStatus } from '../services/orders';
import { slotAvailability, isDateOpen } from '../services/reservations';
import { sendPushToAdmins } from '../services/push';
import { packageDefaults } from '../services/pricing';

const r = Router();

// Helper to extract session ID from body, query, or headers
function getSessionId(req: Request): string {
  return String(
    req.body?.session ||
    req.body?.sessionId ||
    req.query?.session ||
    req.query?.sessionId ||
    req.headers?.['x-session-id'] ||
    req.headers?.['x-session'] ||
    ''
  ).trim();
}

async function getOrCreateCustomer(sessionId: string, name?: string, phone?: string, address?: string): Promise<number> {
  const db = supa();
  const { data: existing } = await db.from('customers').select('*').eq('psid', sessionId).maybeSingle();
  if (existing) {
    const updates: Record<string, any> = {};
    if (name && (!existing.name || existing.name === 'Web Customer')) updates.name = name;
    if (phone && !existing.phone) updates.phone = phone;
    if (address && !existing.address) updates.address = address;
    if (Object.keys(updates).length > 0) {
      await db.from('customers').update(updates).eq('id', existing.id);
    }
    return Number(existing.id);
  }

  const { data: created, error } = await db
    .from('customers')
    .insert({
      psid: sessionId,
      name: name || 'Web Customer',
      phone: phone ?? null,
      address: address ?? null,
    })
    .select('id')
    .maybeSingle();

  if (created) return Number(created.id);

  // Fallback in case of concurrent insert
  const { data: retry } = await db.from('customers').select('id').eq('psid', sessionId).maybeSingle();
  if (retry) return Number(retry.id);

  throw new Error(error?.message || 'Failed to get or create customer record');
}

// ==========================================
// Catalog endpoints (READ)
// ==========================================

r.get('/categories', async (_req, res) => {
  try {
    const { data, error } = await supa().from('categories').select('*').eq('active', 1).order('sort_order');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

r.get('/categories/:id', async (req, res) => {
  try {
    const { data, error } = await supa().from('categories').select('*').eq('id', req.params.id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Category not found' });
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

r.get('/products', async (req, res) => {
  try {
    let query = supa().from('products').select('*, product_variants(*)').eq('active', 1).order('category_id, sort_order');
    if (req.query.category_id) {
      query = query.eq('category_id', req.query.category_id);
    }
    const { data: products, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Expose both variants and product_variants for backward and forward compatibility
    const formatted = (products || []).map((p: any) => ({
      ...p,
      variants: p.product_variants || [],
    }));
    res.json(formatted);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

r.get('/products/:id', async (req, res) => {
  try {
    const { data: product, error } = await supa()
      .from('products')
      .select('*, product_variants(*)')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({
      ...product,
      variants: product.product_variants || [],
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

r.get('/packages', async (_req, res) => {
  try {
    const { data: packages, error } = await supa()
      .from('packages')
      .select('*, package_slots(*, package_options(*, products(name, photo_url)))')
      .eq('active', 1)
      .order('id');
    if (error) return res.status(500).json({ error: error.message });

    const formatted = (packages || []).map((pkg: any) => {
      const rawSlots = pkg.package_slots || [];
      const slots = rawSlots
        .sort((a: any, b: any) => (a.slot_number || 0) - (b.slot_number || 0))
        .map((slot: any) => {
          const rawOpts = slot.package_options || [];
          const options = rawOpts
            .sort((a: any, b: any) => (b.is_default || 0) - (a.is_default || 0) || (a.id || 0) - (b.id || 0))
            .map((opt: any) => ({
              ...opt,
              name: opt.products?.name || opt.name || 'Option',
              photo_url: opt.products?.photo_url || opt.photo_url || null,
            }));
          return {
            ...slot,
            options,
            package_options: options,
          };
        });
      return {
        ...pkg,
        slots,
        package_slots: slots,
      };
    });
    res.json(formatted);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

r.get('/packages/:id', async (req, res) => {
  try {
    const { data: pkg, error } = await supa()
      .from('packages')
      .select('*, package_slots(*, package_options(*, products(name, photo_url)))')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!pkg) return res.status(404).json({ error: 'Package not found' });

    const rawSlots = pkg.package_slots || [];
    const slots = rawSlots
      .sort((a: any, b: any) => (a.slot_number || 0) - (b.slot_number || 0))
      .map((slot: any) => {
        const rawOpts = slot.package_options || [];
        const options = rawOpts
          .sort((a: any, b: any) => (b.is_default || 0) - (a.is_default || 0) || (a.id || 0) - (b.id || 0))
          .map((opt: any) => ({
            ...opt,
            name: opt.products?.name || opt.name || 'Option',
            photo_url: opt.products?.photo_url || opt.photo_url || null,
          }));
        return {
          ...slot,
          options,
          package_options: options,
        };
      });
    res.json({
      ...pkg,
      slots,
      package_slots: slots,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

r.get('/food-packs', async (_req, res) => {
  try {
    const { data, error } = await supa().from('food_packs').select('*').eq('active', 1).order('sort_order');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

r.get('/food-packs/:id', async (req, res) => {
  try {
    const { data, error } = await supa().from('food_packs').select('*').eq('id', req.params.id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Food pack not found' });
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// Cart endpoints (CRUD: Create, Read, Update, Delete)
// ==========================================

// READ: Get cart items and totals
const handleGetCart = async (req: Request, res: Response) => {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId) return res.json({ items: [], totals: { subtotal: 0, delivery: 0, total: 0 } });
    const items = await getCart(sessionId);
    const totals = await cartTotals(sessionId);
    res.json({ items, totals });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
};
r.get('/cart', handleGetCart);
r.get('/cart/items', handleGetCart);

// CREATE: Add item to cart
const handleAddToCart = async (req: Request, res: Response) => {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId) return res.status(400).json({ error: 'No session' });

    const productId = req.body?.product_id ?? req.body?.productId ?? null;
    const packageId = req.body?.package_id ?? req.body?.packageId ?? null;
    const foodPackId = req.body?.food_pack_id ?? req.body?.foodPackId ?? null;
    let variantSize = req.body?.variant_size ?? req.body?.variantSize ?? null;
    const quantity = Math.max(1, Number((req.body?.quantity ?? req.body?.qty) || 1));
    let slotChoices = req.body?.slot_choices ?? req.body?.slotChoices ?? null;

    if (!productId && !packageId && !foodPackId) {
      return res.status(400).json({ error: 'Must provide product_id, package_id, or food_pack_id' });
    }

    // Auto-detect variant size if not provided for product
    if (productId && !variantSize) {
      const { data: v } = await supa().from('product_variants').select('size').eq('product_id', Number(productId)).order('price').limit(1).maybeSingle();
      if (v?.size) variantSize = v.size;
    }

    // Auto-populate default slot choices if not provided for package
    if (packageId && (!slotChoices || (Array.isArray(slotChoices) && slotChoices.length === 0))) {
      const defaults = await packageDefaults(Number(packageId));
      if (defaults && defaults.length > 0) {
        slotChoices = defaults;
      }
    }

    await addItem(sessionId, {
      product_id: productId ? Number(productId) : null,
      package_id: packageId ? Number(packageId) : null,
      food_pack_id: foodPackId ? Number(foodPackId) : null,
      variant_size: variantSize ? String(variantSize) : null,
      quantity,
      slot_choices: slotChoices ?? null,
    });

    const items = await getCart(sessionId);
    const totals = await cartTotals(sessionId);
    res.json({ ok: true, items, totals });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
};
r.post('/cart/add', handleAddToCart);
r.post('/cart', handleAddToCart);
r.post('/cart/items', handleAddToCart);

// UPDATE: Update item quantity or details
const handleUpdateCart = async (req: Request, res: Response) => {
  try {
    const sessionId = getSessionId(req);
    const rawItemId = req.params.id || req.body?.item_id || req.body?.id || req.body?.itemId || req.query?.item_id || req.query?.id;
    const itemId = Number(rawItemId);
    const rawQty = req.body?.quantity ?? req.body?.qty ?? req.query?.quantity ?? req.query?.qty;

    if (!sessionId || !itemId) {
      return res.status(400).json({ error: 'Missing session or item_id' });
    }
    if (rawQty === undefined || rawQty === null) {
      return res.status(400).json({ error: 'Missing quantity' });
    }

    const quantity = Number(rawQty);
    await updateQuantity(sessionId, itemId, quantity);

    const items = await getCart(sessionId);
    const totals = await cartTotals(sessionId);
    res.json({ ok: true, items, totals });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
};
r.post('/cart/update-quantity', handleUpdateCart);
r.put('/cart/update-quantity', handleUpdateCart);
r.post('/cart/update', handleUpdateCart);
r.put('/cart/update', handleUpdateCart);
r.put('/cart/items/:id', handleUpdateCart);
r.patch('/cart/items/:id', handleUpdateCart);
r.put('/cart/:id', handleUpdateCart);
r.patch('/cart/:id', handleUpdateCart);

// DELETE: Remove single item from cart
const handleRemoveItem = async (req: Request, res: Response) => {
  try {
    const sessionId = getSessionId(req);
    const rawItemId = req.params.id || req.body?.item_id || req.body?.id || req.body?.itemId || req.query?.item_id || req.query?.id;
    const itemId = Number(rawItemId);

    if (!sessionId || !itemId) {
      return res.status(400).json({ error: 'Missing session or item_id' });
    }

    await removeItem(sessionId, itemId);
    const items = await getCart(sessionId);
    const totals = await cartTotals(sessionId);
    res.json({ ok: true, items, totals });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
};
r.post('/cart/remove', handleRemoveItem);
r.delete('/cart/remove', handleRemoveItem);
r.delete('/cart/items/:id', handleRemoveItem);
r.delete('/cart/:id', handleRemoveItem);

// DELETE ALL: Clear entire cart
const handleClearCart = async (req: Request, res: Response) => {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId) return res.status(400).json({ error: 'No session' });

    await clearCart(sessionId);
    res.json({ ok: true, items: [], totals: { subtotal: 0, delivery: 0, total: 0 } });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
};
r.post('/cart/clear', handleClearCart);
r.delete('/cart/clear', handleClearCart);
r.delete('/cart', handleClearCart);
r.delete('/cart/items', handleClearCart);

// ==========================================
// Checkout & Orders (CRUD: Create, Read, Update/Cancel)
// ==========================================

// CREATE: Place order from cart
// The webview keeps its cart client-side; when `items` is provided those are used
// (and re-priced server-side). Without `items` it falls back to the DB cart (bot flow).
r.post('/checkout', async (req, res) => {
  const sessionId = getSessionId(req);
  if (!sessionId) return res.status(400).json({ error: 'No session' });
  const { order_type, address, phone, payment_method, fulfillment_date, time_slot, name, notes, items } = req.body;

  try {
    const custId = await getOrCreateCustomer(sessionId, name, phone, address);
    if (phone || address || name) {
      const updates: Record<string, any> = {};
      if (phone) updates.phone = phone;
      if (address) updates.address = address;
      if (name) updates.name = name;
      await supa().from('customers').update(updates).eq('id', custId);
    }

    const order = await createOrderFromCart(sessionId, {
      customer_id: custId,
      order_type: order_type || 'delivery',
      address,
      phone,
      fulfillment_date,
      time_slot,
      payment_method,
      notes,
    }, Array.isArray(items) ? items : undefined);

    // Notify admins via web push
    try {
      sendPushToAdmins({
        title: `🆕 New Order ${order.orderNumber}`,
        body: `${name || 'Web customer'} placed an order (₱${Number(order.total || 0).toLocaleString()}).`,
        data: { url: '/admin#orders' },
      }).catch(() => {});
    } catch {
      // Non-fatal if push fails
    }

    res.json({ ok: true, order_id: order.orderId, order_number: order.orderNumber, total: order.total });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// READ: Get customer orders
r.get('/orders', async (req, res) => {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId) return res.json([]);
    const { data: cust } = await supa().from('customers').select('id').eq('psid', sessionId).maybeSingle();
    if (!cust) return res.json([]);
    const limit = Number(req.query.limit) || 20;
    const orders = await getCustomerOrders(cust.id, limit);
    res.json(orders);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// READ: Get single order by ID
r.get('/orders/:id', async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    if (!orderId) return res.status(400).json({ error: 'Invalid order ID' });
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ error: 'Not found' });
    const items = await getOrderItems(orderId);
    res.json({ ...order, items });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// UPDATE/DELETE: Cancel pending order
const handleCancelOrder = async (req: Request, res: Response) => {
  try {
    const sessionId = getSessionId(req);
    const rawOrderId = req.params.id || req.body?.order_id || req.body?.id;
    const orderId = Number(rawOrderId);
    if (!orderId) return res.status(400).json({ error: 'Missing order ID' });

    let customerId: number | undefined;
    if (sessionId) {
      const { data: cust } = await supa().from('customers').select('id').eq('psid', sessionId).maybeSingle();
      if (cust) customerId = Number(cust.id);
    }

    if (customerId) {
      const result = await cancelOrder(orderId, customerId);
      if (!result.ok) return res.status(400).json({ error: result.message });
      return res.json({ ok: true, message: result.message });
    }

    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'PENDING') {
      return res.status(400).json({ error: `Cannot cancel order in ${order.status} status` });
    }
    await updateOrderStatus(orderId, 'CANCELLED');
    res.json({ ok: true, message: 'Order cancelled successfully' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
};
r.post('/orders/:id/cancel', handleCancelOrder);
r.put('/orders/:id/cancel', handleCancelOrder);
r.delete('/orders/:id', handleCancelOrder);

// ==========================================
// Reservations / Slots / Settings / Config
// ==========================================

r.get('/slots', async (req, res) => {
  try {
    const date = String(req.query.date || '');
    if (!date) return res.status(400).json({ error: 'No date' });
    const open = await isDateOpen(date);
    const slots = await slotAvailability(date);
    res.json({ open, slots });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Check if webview is enabled ----

r.get('/enabled', async (_req, res) => {
  try {
    const { data: row } = await supa().from('app_settings').select('value').eq('key', 'webview_enabled').maybeSingle();
    const enabled = row ? row.value === '1' : true; // default to enabled
    res.json({ enabled });
  } catch {
    // If table doesn't exist or any error, default to enabled
    res.json({ enabled: true });
  }
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
