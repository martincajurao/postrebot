﻿import { one, many, run, query, tx } from '../db';
import { computeCartTotals, choiceUpgrade } from './pricing';
import { clearCart, getCart } from './cart';

export async function nextOrderNumber(): Promise<string> {
  const row = await one("SELECT COALESCE(MAX(id), 1000) + 1 AS next FROM orders") as any;
  return `PP-${row.next}`;
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
  }
) {
  let deliveryFee = 0;
  if (details.order_type === 'delivery') {
    if (details.delivery_area_id) {
      const area = await one('SELECT fee FROM delivery_areas WHERE id = $1 AND active = 1', [details.delivery_area_id]) as any;
      if (!area) throw new Error('Invalid delivery area');
      deliveryFee = area.fee;
    }
  }
  const items = await getCart(psid);
  if (items.length === 0) throw new Error('Cart is empty');
  const totals = await computeCartTotals(items, deliveryFee);

  const result = await tx(async (client) => {
    const orderNumber = await nextOrderNumber();
    const res = await client.query(`INSERT INTO orders
      (order_number, customer_id, order_type, address, delivery_fee, subtotal, total,
       fulfillment_date, time_slot, payment_method, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [orderNumber, details.customer_id, details.order_type, details.address ?? null,
        deliveryFee, totals.subtotal, totals.total,
        details.fulfillment_date ?? null, details.time_slot ?? null,
        details.payment_method ?? null, details.notes ?? null
      ]);
    const orderId = Number(res.rows[0].id);
    for (const it of items) {
      const line = await computeCartTotals([it], 0);
      const unit = Math.round(line.subtotal / it.quantity);
      const r = await client.query(`INSERT INTO order_items
        (order_id, product_id, package_id, name, variant_size, quantity, unit_price, line_total)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [orderId, it.product_id ?? null, it.package_id ?? null, it.name,
          it.variant_size ?? null, it.quantity, unit, line.subtotal]);
      const orderItemId = Number(r.rows[0].id);
      if (it.package_id && it.slot_choices) {
        for (const c of it.slot_choices) {
          const prod = await one('SELECT name FROM products WHERE id = $1', [c.product_id]) as any;
          let extra = 0;
          try { extra = await choiceUpgrade(it.package_id, c.slot_number, c.product_id, it.variant_size); } catch { extra = 0; }
          await client.query(`INSERT INTO order_package_items
            (order_item_id, slot_number, product_id, product_name, upgrade_price) VALUES ($1, $2, $3, $4, $5)`,
            [orderItemId, c.slot_number, c.product_id, prod?.name ?? 'Unknown', extra]);
        }
      }
    }
    await client.query('INSERT INTO order_status_history (order_id, status) VALUES ($1, $2)', [orderId, 'PENDING']);
    // If reserved for a date/slot, create the reservation row
    if (details.fulfillment_date && details.time_slot) {
      const cust = await one('SELECT name, phone FROM customers WHERE id = $1', [details.customer_id]) as any;
      await client.query(`INSERT INTO reservations (order_id, customer_name, phone, res_date, time_slot, status, notes)
        VALUES ($1, $2, $3, $4, $5, 'PENDING', $6)`,
        [orderId, cust?.name ?? 'Messenger customer', cust?.phone ?? null,
          details.fulfillment_date, details.time_slot, details.notes ?? null]);
    }
    return { orderId, orderNumber, total: totals.total };
  });

  await clearCart(psid);
  return result;
}

export async function updateOrderStatus(orderId: number, status: string): Promise<void> {
  const allowed = ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'];
  if (!allowed.includes(status)) throw new Error('Invalid status');
  await run('UPDATE orders SET status = $1 WHERE id = $2', [status, orderId]);
  await run('INSERT INTO order_status_history (order_id, status) VALUES ($1, $2)', [orderId, status]);
}

export async function updatePaymentStatus(orderId: number, paymentStatus: string): Promise<void> {
  const allowed = ['UNPAID', 'PAYMENT_SUBMITTED', 'PAID'];
  if (!allowed.includes(paymentStatus)) throw new Error('Invalid payment status');
  await run('UPDATE orders SET payment_status = $1 WHERE id = $2', [paymentStatus, orderId]);
}

// ---------- Order History & Tracking ----------

export async function getCustomerOrders(customerId: number, limit = 5): Promise<any[]> {
  const orders = await many(
    'SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT $2',
    [customerId, limit]
  ) as any[];

  // Fetch current status for each order
  for (const order of orders) {
    const statusRow = await one(
      'SELECT status FROM order_status_history WHERE order_id = $1 ORDER BY id DESC LIMIT 1',
      [order.id]
    ) as any;
    order.current_status = statusRow?.status || order.status;
  }

  return orders;
}

export async function getOrderById(orderId: number): Promise<any> {
  return await one('SELECT * FROM orders WHERE id = $1', [orderId]);
}

export async function getOrderByNumber(orderNumber: string): Promise<any> {
  return await one('SELECT * FROM orders WHERE order_number = $1', [orderNumber]);
}

export async function getOrderItems(orderId: number): Promise<any[]> {
  const items = await many(
    'SELECT * FROM order_items WHERE order_id = $1',
    [orderId]
  ) as any[];

  // Fetch package items for each order item
  for (const item of items) {
    if (item.package_id) {
      item.package_items = await many(
        'SELECT slot_number, product_id, product_name, upgrade_price FROM order_package_items WHERE order_item_id = $1 ORDER BY slot_number',
        [item.id]
      );
    } else {
      item.package_items = [];
    }
  }

  return items;
}

export async function getOrderStatusHistory(orderId: number): Promise<any[]> {
  return await many(
    'SELECT * FROM order_status_history WHERE order_id = $1 ORDER BY created_at ASC',
    [orderId]
  );
}

// ---------- Order Cancellation ----------

export async function cancelOrder(orderId: number, customerId: number): Promise<{ ok: boolean; message: string }> {
  const order = await one('SELECT * FROM orders WHERE id = $1 AND customer_id = $2', [orderId, customerId]);
  if (!order) {
    return { ok: false, message: 'Order not found' };
  }
  const status = (order as any).status;
  if (!['PENDING'].includes(status)) {
    return { ok: false, message: `Order can no longer be cancelled (current status: ${status})` };
  }
  await updateOrderStatus(orderId, 'CANCELLED');
  return { ok: true, message: 'Order cancelled successfully' };
}

// ---------- Order Rating ----------

export async function rateOrder(orderId: number, customerId: number, rating: number, feedback?: string): Promise<void> {
  if (rating < 1 || rating > 5) throw new Error('Rating must be between 1 and 5');
  const order = await one('SELECT * FROM orders WHERE id = $1 AND customer_id = $2', [orderId, customerId]);
  if (!order) throw new Error('Order not found');
  if ((order as any).status !== 'COMPLETED') throw new Error('Can only rate completed orders');
  // Check if already rated
  const existing = await one('SELECT id FROM order_ratings WHERE order_id = $1', [orderId]);
  if (existing) throw new Error('Order already rated');
  await run(
    'INSERT INTO order_ratings (order_id, rating, feedback) VALUES ($1, $2, $3)',
    [orderId, rating, feedback ?? null]
  );
}

// ---------- Cart Expiration Cleanup ----------

export async function cleanupAbandonedCarts(hoursOld = 24): Promise<number> {
  const result = await run(
    `DELETE FROM carts WHERE updated_at < (now()::text::timestamp - interval '${hoursOld} hours')`
  );
  return result;
}