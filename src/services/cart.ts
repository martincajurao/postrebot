import { db } from '../db/database';
import { computeCartTotals, normalizeChoices } from './pricing';

export function getOrCreateCart(psid: string): number {
  let cart = db.prepare('SELECT id FROM carts WHERE psid = ?').get(psid) as any;
  if (!cart) {
    db.prepare('INSERT INTO carts (psid) VALUES (?)').run(psid);
    cart = db.prepare('SELECT id FROM carts WHERE psid = ?').get(psid) as any;
  }
  return cart.id;
}

export function addItem(psid: string, item: any): void {
  const cartId = getOrCreateCart(psid);
  db.prepare(`INSERT INTO cart_items (cart_id, product_id, package_id, variant_size, quantity, slot_choices)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    cartId,
    item.product_id ?? null,
    item.package_id ?? null,
    item.variant_size ?? null,
    item.quantity || 1,
    item.slot_choices ? JSON.stringify(item.slot_choices) : null
  );
  db.prepare("UPDATE carts SET updated_at = datetime('now') WHERE id = ?").run(cartId);
}

export function removeItem(psid: string, itemId: number): void {
  const cartId = getOrCreateCart(psid);
  db.prepare('DELETE FROM cart_items WHERE id = ? AND cart_id = ?').run(itemId, cartId);
}

export function updateQuantity(psid: string, itemId: number, quantity: number): void {
  const cartId = getOrCreateCart(psid);
  if (quantity <= 0) return removeItem(psid, itemId);
  db.prepare('UPDATE cart_items SET quantity = ? WHERE id = ? AND cart_id = ?').run(quantity, itemId, cartId);
}

export function getCart(psid: string) {
  const cartId = getOrCreateCart(psid);
  const items = db.prepare(`
    SELECT ci.*, p.name AS product_name, pk.name AS package_name
    FROM cart_items ci
    LEFT JOIN products p ON p.id = ci.product_id
    LEFT JOIN packages pk ON pk.id = ci.package_id
    WHERE ci.cart_id = ?`).all(cartId) as any[];
  return items.map((it: any) => ({
    id: it.id,
    name: it.package_name ? `${it.package_name} (package)` : `${it.product_name} ${it.variant_size || ''}`.trim(),
    quantity: it.quantity,
    slot_choices: it.slot_choices ? normalizeChoices(JSON.parse(it.slot_choices)) : null,
    product_id: it.product_id,
    package_id: it.package_id,
    variant_size: it.variant_size,
  }));
}

export function clearCart(psid: string): void {
  const cartId = getOrCreateCart(psid);
  db.prepare('DELETE FROM cart_items WHERE cart_id = ?').run(cartId);
}

export function cartTotals(psid: string, deliveryFee = 0) {
  const items = getCart(psid);
  return computeCartTotals(items, deliveryFee);
}
