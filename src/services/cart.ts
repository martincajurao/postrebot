import { one, many, run, insertReturningId } from '../db';
import { computeCartTotals, normalizeChoices } from './pricing';

export async function getOrCreateCart(psid: string): Promise<number> {
  let cart = await one('SELECT id FROM carts WHERE psid = $1', [psid]) as any;
  if (!cart) {
    await run('INSERT INTO carts (psid) VALUES ($1)', [psid]);
    cart = await one('SELECT id FROM carts WHERE psid = $1', [psid]) as any;
  }
  return cart.id;
}

export async function addItem(psid: string, item: any): Promise<void> {
  const cartId = await getOrCreateCart(psid);
  await run(`INSERT INTO cart_items (cart_id, product_id, package_id, variant_size, quantity, slot_choices)
    VALUES ($1, $2, $3, $4, $5, $6)`,
    [cartId,
      item.product_id ?? null,
      item.package_id ?? null,
      item.variant_size ?? null,
      item.quantity || 1,
      item.slot_choices ? JSON.stringify(item.slot_choices) : null
    ]);
  await run('UPDATE carts SET updated_at = now()::text WHERE id = $1', [cartId]);
}

export async function removeItem(psid: string, itemId: number): Promise<void> {
  const cartId = await getOrCreateCart(psid);
  await run('DELETE FROM cart_items WHERE id = $1 AND cart_id = $2', [itemId, cartId]);
}

export async function updateQuantity(psid: string, itemId: number, quantity: number): Promise<void> {
  const cartId = await getOrCreateCart(psid);
  if (quantity <= 0) return removeItem(psid, itemId);
  await run('UPDATE cart_items SET quantity = $1 WHERE id = $2 AND cart_id = $3', [quantity, itemId, cartId]);
}

export async function getCart(psid: string) {
  const cartId = await getOrCreateCart(psid);
  const items = await many(`
    SELECT ci.*, p.name AS product_name, pk.name AS package_name
    FROM cart_items ci
    LEFT JOIN products p ON p.id = ci.product_id
    LEFT JOIN packages pk ON pk.id = ci.package_id
    WHERE ci.cart_id = $1`, [cartId]) as any[];
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

export async function clearCart(psid: string): Promise<void> {
  const cartId = await getOrCreateCart(psid);
  await run('DELETE FROM cart_items WHERE cart_id = $1', [cartId]);
}

export async function cartTotals(psid: string, deliveryFee = 0) {
  const items = await getCart(psid);
  return computeCartTotals(items, deliveryFee);
}