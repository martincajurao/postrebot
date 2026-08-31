import { db } from '../db/database';
import { computeCartTotals, choiceUpgrade } from './pricing';
import { clearCart, getCart } from './cart';

export function nextOrderNumber(): string {
  const row = db.prepare("SELECT COALESCE(MAX(id), 1000) + 1 AS next FROM orders").get() as any;
  return `PP-${row.next}`;
}

export function createOrderFromCart(
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
      const area = db.prepare('SELECT fee FROM delivery_areas WHERE id = ? AND active = 1').get(details.delivery_area_id) as any;
      if (!area) throw new Error('Invalid delivery area');
      deliveryFee = area.fee;
    }
  }
  const items = getCart(psid);
  if (items.length === 0) throw new Error('Cart is empty');
  const totals = computeCartTotals(items, deliveryFee);

  const tx = db.transaction(() => {
    const orderNumber = nextOrderNumber();
    const res = db.prepare(`INSERT INTO orders
      (order_number, customer_id, order_type, address, delivery_fee, subtotal, total,
       fulfillment_date, time_slot, payment_method, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      orderNumber, details.customer_id, details.order_type, details.address ?? null,
      deliveryFee, totals.subtotal, totals.total,
      details.fulfillment_date ?? null, details.time_slot ?? null,
      details.payment_method ?? null, details.notes ?? null
    );
    const orderId = Number(res.lastInsertRowid);
    const insItem = db.prepare(`INSERT INTO order_items
      (order_id, product_id, package_id, name, variant_size, quantity, unit_price, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const insPkgItem = db.prepare(`INSERT INTO order_package_items
      (order_item_id, slot_number, product_name, upgrade_price) VALUES (?, ?, ?, ?)`);
    for (const it of items) {
      const line = computeCartTotals([it], 0);
      const unit = Math.round(line.subtotal / it.quantity);
      const r = insItem.run(orderId, it.product_id ?? null, it.package_id ?? null, it.name,
        it.variant_size ?? null, it.quantity, unit, line.subtotal);
      if (it.package_id && it.slot_choices) {
        for (const c of it.slot_choices) {
          const prod = db.prepare('SELECT name FROM products WHERE id = ?').get(c.product_id) as any;
          let extra = 0;
          try { extra = choiceUpgrade(it.package_id, c.slot_number, c.product_id, it.variant_size); } catch { extra = 0; }
          insPkgItem.run(Number(r.lastInsertRowid), c.slot_number, prod?.name ?? 'Unknown', extra);
        }
      }
    }
    db.prepare('INSERT INTO order_status_history (order_id, status) VALUES (?, ?)').run(orderId, 'PENDING');
    // If reserved for a date/slot, create the reservation row
    if (details.fulfillment_date && details.time_slot) {
      const cust = db.prepare('SELECT name, phone FROM customers WHERE id = ?').get(details.customer_id) as any;
      db.prepare(`INSERT INTO reservations (order_id, customer_name, phone, res_date, time_slot, status, notes)
        VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`).run(
        orderId, cust?.name ?? 'Messenger customer', cust?.phone ?? null,
        details.fulfillment_date, details.time_slot, details.notes ?? null);
    }
    return { orderId, orderNumber, total: totals.total };
  });

  const result = tx();
  clearCart(psid);
  return result;
}

export function updateOrderStatus(orderId: number, status: string): void {
  const allowed = ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'];
  if (!allowed.includes(status)) throw new Error('Invalid status');
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, orderId);
  db.prepare('INSERT INTO order_status_history (order_id, status) VALUES (?, ?)').run(orderId, status);
}

export function updatePaymentStatus(orderId: number, paymentStatus: string): void {
  const allowed = ['UNPAID', 'PAYMENT_SUBMITTED', 'PAID'];
  if (!allowed.includes(paymentStatus)) throw new Error('Invalid payment status');
  db.prepare('UPDATE orders SET payment_status = ? WHERE id = ?').run(paymentStatus, orderId);
}
