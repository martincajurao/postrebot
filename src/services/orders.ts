﻿import { supa } from '../db/supabase';
import { computeCartTotals, choiceUpgrade, normalizeChoices, priceFoodPack, pricePackage, priceProduct } from './pricing';
import { clearCart, getCart } from './cart';

/**
 * Resolve a webview client-side cart into priced order items.
 * Every line is re-priced from the DB (priceProduct/pricePackage/priceFoodPack),
 * so client-sent amounts are never trusted — only *what* was ordered.
 * Throws on any unpriceable/invalid item so checkout fails loudly.
 */
async function resolveClientCartItems(rawItems: any[]): Promise<any[]> {
  if (rawItems.length > 50) throw new Error('Too many items in cart');
  const db = supa();
  const out: any[] = [];

  for (const raw of rawItems) {
    const quantity = Math.max(1, Math.min(99, Math.floor(Number(raw?.quantity) || 0)));
    if (!quantity) throw new Error('Invalid item quantity');

    const productId = Number(raw?.product_id) || 0;
    const packageId = Number(raw?.package_id) || 0;
    const foodPackId = Number(raw?.food_pack_id) || 0;
    const kinds = [productId, packageId, foodPackId].filter((n) => n > 0).length;
    if (kinds !== 1) throw new Error('Invalid cart item');

    if (productId > 0) {
      const variantSize = raw.variant_size ? String(raw.variant_size) : undefined;
      const price = await priceProduct(productId, variantSize); // throws on invalid product/size
      const { data: prod } = await db.from('products').select('name').eq('id', productId).maybeSingle();
      out.push({
        product_id: productId,
        package_id: null,
        food_pack_id: null,
        variant_size: variantSize ?? null,
        quantity,
        slot_choices: null,
        name: `${prod?.name || 'Item'} ${variantSize || ''}`.trim(),
        unit_price: price,
        line_total: price * quantity,
        discount: 0,
      });
    } else if (packageId > 0) {
      const variantSize = raw.variant_size ? String(raw.variant_size) : undefined;
      const slotChoices = normalizeChoices(raw?.slot_choices);
      const { total, breakdown } = await pricePackage(packageId, slotChoices, variantSize); // throws on invalid package
      const { data: pkg } = await db.from('packages').select('name').eq('id', packageId).maybeSingle();
      const itemDiscount = breakdown
        .filter((b: any) => b.amount < 0)
        .reduce((s: number, b: any) => s + -b.amount, 0) * quantity;
      out.push({
        product_id: null,
        package_id: packageId,
        food_pack_id: null,
        variant_size: variantSize ?? null,
        quantity,
        slot_choices: slotChoices,
        name: `${pkg?.name || 'Package'} (package)`,
        unit_price: Math.round(total / quantity),
        line_total: total * quantity,
        discount: itemDiscount,
      });
    } else {
      const { price, name } = await priceFoodPack(foodPackId); // throws on invalid food pack
      out.push({
        product_id: null,
        package_id: null,
        food_pack_id: foodPackId,
        variant_size: null,
        quantity,
        slot_choices: null,
        name: `${name} (food pack)`,
        unit_price: price,
        line_total: price * quantity,
        discount: 0,
      });
    }
  }
  return out;
}

/** Totals for a client-resolved cart (already priced per line). */
function totalsFromResolvedItems(items: any[]) {
  const subtotal = items.reduce((s, it) => s + (Number(it.line_total) || 0), 0);
  const discount = items.reduce((s, it) => s + (Number(it.discount) || 0), 0);
  const breakdown = items.map((it) => ({ label: `${it.name} x${it.quantity}`, amount: it.line_total }));
  return { subtotal, delivery: 0, discount, total: subtotal, breakdown };
}

export async function nextOrderNumber(): Promise<string> {
  const { data } = await supa().from('orders').select('id').order('id', { ascending: false }).limit(1).maybeSingle();
  const next = (data?.id || 1000) + 1;
  return `PP-${next}`;
}

export async function createOrderFromCart(
  psid: string,
  details: {
    customer_id: number;
    order_type: 'delivery' | 'pickup';
    address?: string;
    delivery_area_id?: number;
    fulfillment_date?: string;
    time_slot?: string;
    payment_method?: string;
    phone?: string;
    notes?: string;
  },
  clientItems?: any[]
) {
  let deliveryFee = 0;
  // Delivery fee is intentionally NOT auto-charged at order time — the admin enters
  // the actual fare when confirming the order (POST /orders/:id/confirm). This way
  // the customer is not billed a pre-set estimate before the order is reviewed.

  // Two cart sources:
  //  - clientItems: the webview's local cart (items only; every line is re-priced
  //    server-side in resolveClientCartItems — client amounts are never trusted).
  //  - DB cart: the Messenger bot flow (unchanged).
  const usingClientCart = Array.isArray(clientItems) && clientItems.length > 0;
  const items = usingClientCart ? await resolveClientCartItems(clientItems) : await getCart(psid);
  if (items.length === 0) throw new Error('Cart is empty');
  const totals = usingClientCart ? totalsFromResolvedItems(items) : await computeCartTotals(items, deliveryFee);

  const db = supa();
  const orderNumber = await nextOrderNumber();
  const { data: orderRow, error: orderErr } = await db.from('orders').insert({
    order_number: orderNumber,
    customer_id: details.customer_id,
    order_type: details.order_type,
    address: details.address ?? null,
    delivery_fee: deliveryFee,
    subtotal: totals.subtotal,
    total: totals.total,
    fulfillment_date: details.fulfillment_date ?? null,
    time_slot: details.time_slot ?? null,
    payment_method: details.payment_method ?? null,
    notes: details.notes ?? null,
  }).select('id').single();
  if (orderErr) throw new Error(`Order creation failed: ${orderErr.message}`);
  const orderId = Number(orderRow!.id);

  for (const it of items) {
    let unit: number;
    let lineSubtotal: number;
    if (it.unit_price !== undefined && it.line_total !== undefined) {
      // Client-resolved cart: lines were already priced server-side in resolveClientCartItems.
      unit = Math.round(Number(it.unit_price) || 0);
      lineSubtotal = Number(it.line_total) || 0;
    } else {
      const line = await computeCartTotals([it], 0);
      unit = Math.round(line.subtotal / it.quantity);
      lineSubtotal = line.subtotal;
    }
    const { data: oiRow, error: oiErr } = await db.from('order_items').insert({
      order_id: orderId,
      product_id: it.product_id ?? null,
      package_id: it.package_id ?? null,
      food_pack_id: it.food_pack_id ?? null,
      name: it.name,
      variant_size: it.variant_size ?? null,
      quantity: it.quantity,
      unit_price: unit,
      line_total: lineSubtotal,
    }).select('id').single();
    if (oiErr) throw new Error(`Order item creation failed: ${oiErr.message}`);
    const orderItemId = Number(oiRow!.id);

    if (it.package_id && it.slot_choices) {
      for (const c of it.slot_choices) {
        const { data: prod } = await db.from('products').select('name').eq('id', c.product_id).maybeSingle();
        let extra = 0;
        try { extra = await choiceUpgrade(it.package_id, c.slot_number, c.product_id, it.variant_size); } catch { extra = 0; }
        await db.from('order_package_items').insert({
          order_item_id: orderItemId,
          slot_number: c.slot_number,
          product_id: c.product_id,
          product_name: prod?.name ?? 'Unknown',
          upgrade_price: extra,
        });
      }
    }
  }

  await db.from('order_status_history').insert({ order_id: orderId, status: 'PENDING' });

  // If reserved for a date/slot, create the reservation row
  if (details.fulfillment_date && details.time_slot) {
    const { data: cust } = await db.from('customers').select('name, phone').eq('id', details.customer_id).maybeSingle();
    await db.from('reservations').insert({
      order_id: orderId,
      customer_name: cust?.name ?? 'Messenger customer',
      phone: cust?.phone ?? null,
      res_date: details.fulfillment_date,
      time_slot: details.time_slot,
      status: 'PENDING',
      notes: details.notes ?? null,
    });
  }

  await clearCart(psid);
  return { orderId, orderNumber, total: totals.total };
}

export async function updateOrderStatus(orderId: number, status: string): Promise<void> {
  const allowed = ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'];
  if (!allowed.includes(status)) throw new Error('Invalid status');
  const db = supa();
  await db.from('orders').update({ status }).eq('id', orderId);
  await db.from('order_status_history').insert({ order_id: orderId, status });
}

export async function updatePaymentStatus(orderId: number, paymentStatus: string): Promise<void> {
  const allowed = ['UNPAID', 'PAYMENT_SUBMITTED', 'PAID'];
  if (!allowed.includes(paymentStatus)) throw new Error('Invalid payment status');
  await supa().from('orders').update({ payment_status: paymentStatus }).eq('id', orderId);
}

// ---------- Order History & Tracking ----------

export async function getCustomerOrders(customerId: number, limit = 5): Promise<any[]> {
  const db = supa();
  const { data: orders } = await db.from('orders').select('*').eq('customer_id', customerId).order('created_at', { ascending: false }).limit(limit);

  // Fetch current status for each order
  for (const order of orders || []) {
    const { data: statusRow } = await db.from('order_status_history').select('status').eq('order_id', order.id).order('id', { ascending: false }).limit(1).maybeSingle();
    order.current_status = statusRow?.status || order.status;
  }

  return orders || [];
}

export async function getOrderById(orderId: number): Promise<any> {
  const { data } = await supa().from('orders').select('*').eq('id', orderId).maybeSingle();
  return data;
}

export async function getOrderByNumber(orderNumber: string): Promise<any> {
  const { data } = await supa().from('orders').select('*').eq('order_number', orderNumber).maybeSingle();
  return data;
}

export async function getOrderItems(orderId: number): Promise<any[]> {
  const db = supa();
  const { data: items } = await db.from('order_items').select('*').eq('order_id', orderId);

  // Fetch package items for each order item
  for (const item of items || []) {
    if (item.package_id) {
      const { data: pkgItems } = await db.from('order_package_items').select('slot_number, product_id, product_name, upgrade_price').eq('order_item_id', item.id).order('slot_number');
      item.package_items = pkgItems || [];
    } else {
      item.package_items = [];
    }
  }

  return items || [];
}

export async function getOrderStatusHistory(orderId: number): Promise<any[]> {
  const { data } = await supa().from('order_status_history').select('*').eq('order_id', orderId).order('created_at');
  return data || [];
}

// ---------- Order Cancellation ----------

export async function cancelOrder(orderId: number, customerId: number): Promise<{ ok: boolean; message: string }> {
  const { data: order } = await supa().from('orders').select('*').eq('id', orderId).eq('customer_id', customerId).maybeSingle();
  if (!order) {
    return { ok: false, message: 'Order not found' };
  }
  const status = order.status;
  if (!['PENDING'].includes(status)) {
    return { ok: false, message: `Order can no longer be cancelled (current status: ${status})` };
  }
  await updateOrderStatus(orderId, 'CANCELLED');
  return { ok: true, message: 'Order cancelled successfully' };
}

/** Customer-side completion: allowed only once the order is READY (received). */
export async function completeOrderByCustomer(orderId: number, customerId: number): Promise<{ ok: boolean; message: string }> {
  const { data: order } = await supa().from('orders').select('*').eq('id', orderId).eq('customer_id', customerId).maybeSingle();
  if (!order) {
    return { ok: false, message: 'Order not found' };
  }
  const status = order.status;
  if (status !== 'READY') {
    return { ok: false, message: `The order can be marked as received once it is READY (current status: ${status})` };
  }
  await updateOrderStatus(orderId, 'COMPLETED');
  return { ok: true, message: 'Order completed' };
}

// ---------- Order Rating ----------

export async function rateOrder(orderId: number, customerId: number, rating: number, feedback?: string): Promise<void> {
  if (rating < 1 || rating > 5) throw new Error('Rating must be between 1 and 5');
  const db = supa();
  const { data: order } = await db.from('orders').select('*').eq('id', orderId).eq('customer_id', customerId).maybeSingle();
  if (!order) throw new Error('Order not found');
  if (order.status !== 'COMPLETED') throw new Error('Can only rate completed orders');
  // Check if already rated
  const { data: existing } = await db.from('order_ratings').select('id').eq('order_id', orderId).maybeSingle();
  if (existing) throw new Error('Order already rated');
  await db.from('order_ratings').insert({ order_id: orderId, rating, feedback: feedback ?? null });
}

// ---------- Cart Expiration Cleanup ----------

export async function cleanupAbandonedCarts(hoursOld = 24): Promise<number> {
  const cutoff = new Date(Date.now() - hoursOld * 60 * 60 * 1000).toISOString();
  const { data } = await supa().from('carts').delete().lt('updated_at', cutoff).select('id');
  return data?.length || 0;
}