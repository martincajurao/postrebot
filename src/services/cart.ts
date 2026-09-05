﻿import { supa } from '../db/supabase';
import { computeCartTotals, normalizeChoices } from './pricing';

export async function getOrCreateCart(psid: string): Promise<number> {
  const db = supa();
  const { data: existing } = await db.from('carts').select('id').eq('psid', psid).maybeSingle();
  if (existing) return existing.id;
  const { data: created } = await db.from('carts').insert({ psid }).select('id').single();
  return created!.id;
}

export async function addItem(psid: string, item: any): Promise<void> {
  const db = supa();
  const cartId = await getOrCreateCart(psid);
  await db.from('cart_items').insert({
    cart_id: cartId,
    product_id: item.product_id ?? null,
    package_id: item.package_id ?? null,
    food_pack_id: item.food_pack_id ?? null,
    variant_size: item.variant_size ?? null,
    quantity: item.quantity || 1,
    slot_choices: item.slot_choices ? JSON.stringify(item.slot_choices) : null,
  });
  await db.from('carts').update({ updated_at: new Date().toISOString() }).eq('id', cartId);
}

export async function removeItem(psid: string, itemId: number): Promise<void> {
  const db = supa();
  const cartId = await getOrCreateCart(psid);
  await db.from('cart_items').delete().eq('id', itemId).eq('cart_id', cartId);
}

export async function updateQuantity(psid: string, itemId: number, quantity: number): Promise<void> {
  const db = supa();
  const cartId = await getOrCreateCart(psid);
  if (quantity <= 0) return removeItem(psid, itemId);
  await db.from('cart_items').update({ quantity }).eq('id', itemId).eq('cart_id', cartId);
}

export async function getCart(psid: string) {
  const db = supa();
  const cartId = await getOrCreateCart(psid);
  const { data: items } = await db
    .from('cart_items')
    .select('*, product:products(name), package:packages(name), food_pack:food_packs(name)')
    .eq('cart_id', cartId)
    .order('id');
  return (items || []).map((it: any) => ({
    id: it.id,
    name: it.food_pack?.name ? `${it.food_pack.name} (food pack)`
      : it.package?.name ? `${it.package.name} (package)` : `${it.product?.name || ''} ${it.variant_size || ''}`.trim(),
    quantity: it.quantity,
    slot_choices: it.slot_choices ? normalizeChoices(JSON.parse(it.slot_choices)) : null,
    product_id: it.product_id,
    package_id: it.package_id,
    food_pack_id: it.food_pack_id,
    variant_size: it.variant_size,
  }));
}

export async function clearCart(psid: string): Promise<void> {
  const db = supa();
  const cartId = await getOrCreateCart(psid);
  await db.from('cart_items').delete().eq('cart_id', cartId);
}

export async function cartTotals(psid: string, deliveryFee = 0) {
  const items = await getCart(psid);
  return await computeCartTotals(items, deliveryFee);
}