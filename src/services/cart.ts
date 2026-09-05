import { supa } from '../db/supabase';
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
  const targetChoices = item.slot_choices ? JSON.stringify(item.slot_choices) : null;

  // Check if identical item already exists in this cart
  let query = db.from('cart_items').select('id, quantity, slot_choices').eq('cart_id', cartId);
  if (item.product_id != null) query = query.eq('product_id', item.product_id); else query = query.is('product_id', null);
  if (item.package_id != null) query = query.eq('package_id', item.package_id); else query = query.is('package_id', null);
  if (item.food_pack_id != null) query = query.eq('food_pack_id', item.food_pack_id); else query = query.is('food_pack_id', null);
  if (item.variant_size != null) query = query.eq('variant_size', item.variant_size); else query = query.is('variant_size', null);

  const { data: existingItems } = await query;
  const match = (existingItems || []).find((it: any) => (it.slot_choices || null) === targetChoices);

  if (match) {
    await db.from('cart_items').update({ quantity: (match.quantity || 1) + (Number(item.quantity) || 1) }).eq('id', match.id);
  } else {
    await db.from('cart_items').insert({
      cart_id: cartId,
      product_id: item.product_id ?? null,
      package_id: item.package_id ?? null,
      food_pack_id: item.food_pack_id ?? null,
      variant_size: item.variant_size ?? null,
      quantity: Number(item.quantity) || 1,
      slot_choices: targetChoices,
    });
  }
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
  const { data: items, error } = await db
    .from('cart_items')
    .select('*')
    .eq('cart_id', cartId)
    .order('id');

  if (error || !items || items.length === 0) return [];

  const prodIds = [...new Set(items.map((it: any) => it.product_id).filter(Boolean))];
  const pkgIds = [...new Set(items.map((it: any) => it.package_id).filter(Boolean))];
  const fpIds = [...new Set(items.map((it: any) => it.food_pack_id).filter(Boolean))];

  const [prodsRes, pkgsRes, fpsRes] = await Promise.all([
    prodIds.length > 0 ? db.from('products').select('id, name').in('id', prodIds) : Promise.resolve({ data: [] }),
    pkgIds.length > 0 ? db.from('packages').select('id, name').in('id', pkgIds) : Promise.resolve({ data: [] }),
    fpIds.length > 0 ? db.from('food_packs').select('id, name').in('id', fpIds) : Promise.resolve({ data: [] }),
  ]);

  const prodMap = new Map((prodsRes.data || []).map((p: any) => [p.id, p.name]));
  const pkgMap = new Map((pkgsRes.data || []).map((p: any) => [p.id, p.name]));
  const fpMap = new Map((fpsRes.data || []).map((f: any) => [f.id, f.name]));

  return items.map((it: any) => {
    let name = '';
    if (it.food_pack_id && fpMap.has(it.food_pack_id)) {
      name = `${fpMap.get(it.food_pack_id)} (food pack)`;
    } else if (it.package_id && pkgMap.has(it.package_id)) {
      name = `${pkgMap.get(it.package_id)} (package)`;
    } else if (it.product_id && prodMap.has(it.product_id)) {
      name = `${prodMap.get(it.product_id)} ${it.variant_size || ''}`.trim();
    } else {
      name = `Item #${it.id}`;
    }

    let parsedChoices = null;
    if (it.slot_choices) {
      try {
        parsedChoices = normalizeChoices(typeof it.slot_choices === 'string' ? JSON.parse(it.slot_choices) : it.slot_choices);
      } catch {
        parsedChoices = null;
      }
    }

    return {
      id: it.id,
      name,
      quantity: it.quantity,
      slot_choices: parsedChoices,
      product_id: it.product_id,
      package_id: it.package_id,
      food_pack_id: it.food_pack_id,
      variant_size: it.variant_size,
    };
  });
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