import { one, many, run, query, tx } from '../db';
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
            (order_item_id, slot_number, product_name, upgrade_price) VALUES ($1, $2, $3, $4)`,
            [orderItemId, c.slot_number, prod?.name ?? 'Unknown', extra]);
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