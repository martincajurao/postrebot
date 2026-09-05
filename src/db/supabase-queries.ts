/**
 * Supabase data access layer — replaces all raw SQL.
 * Every database operation in the codebase should go through here.
 */

import { supa } from './supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

const db: SupabaseClient = supa();

// ---------- Customers ----------

export async function getCustomerByPsid(psid: string): Promise<any | null> {
  const { data } = await db.from('customers').select('*').eq('psid', psid).maybeSingle();
  return data;
}

export async function createCustomer(psid: string): Promise<any> {
  const { data, error } = await db
    .from('customers')
    .insert({ psid, name: null, phone: null, address: null })
    .select('*')
    .single();
  if (error) throw new Error(`Create customer failed: ${error.message}`);
  return data;
}

export async function ensureCustomer(psid: string): Promise<any> {
  const existing = await getCustomerByPsid(psid);
  if (existing) return existing;
  return createCustomer(psid);
}

export async function updateCustomer(psid: string, fields: { name?: string; phone?: string; address?: string }): Promise<void> {
  const updates: Record<string, any> = {};
  if (fields.name !== undefined) updates.name = fields.name;
  if (fields.phone !== undefined) updates.phone = fields.phone;
  if (fields.address !== undefined) updates.address = fields.address;
  if (Object.keys(updates).length === 0) return;
  await db.from('customers').update(updates).eq('psid', psid);
}

export async function getCustomerById(id: number): Promise<any | null> {
  const { data } = await db.from('customers').select('*').eq('id', id).maybeSingle();
  return data;
}

// ---------- Conversation State ----------

export async function getConversationState(psid: string): Promise<{ state: string; ctx: any }> {
  const { data } = await db
    .from('conversation_states')
    .select('state, context_json')
    .eq('psid', psid)
    .maybeSingle();
  return {
    state: data?.state || 'MAIN_MENU',
    ctx: data?.context_json ? JSON.parse(data.context_json) : {},
  };
}

export async function setConversationState(psid: string, state: string, ctx: any = {}): Promise<void> {
  const context_json = JSON.stringify(ctx);
  const existing = await db.from('conversation_states').select('psid').eq('psid', psid).maybeSingle();
  if (existing) {
    await db.from('conversation_states').update({ state, context_json, updated_at: new Date().toISOString() }).eq('psid', psid);
  } else {
    await db.from('conversation_states').insert({ psid, state, context_json, updated_at: new Date().toISOString() });
  }
}

// ---------- Categories ----------

export async function getActiveCategories(): Promise<any[]> {
  const { data } = await db.from('categories').select('*').eq('active', 1).order('sort_order');
  return data || [];
}

export async function getAllCategories(): Promise<any[]> {
  const { data } = await db.from('categories').select('*').order('sort_order');
  return data || [];
}

export async function createCategory(name: string, sort_order: number): Promise<number> {
  const { data, error } = await db
    .from('categories')
    .insert({ name, sort_order })
    .select('id')
    .single();
  if (error) throw new Error(`Create category failed: ${error.message}`);
  return Number(data.id);
}

export async function updateCategory(id: number, fields: { name?: string; active?: number }): Promise<void> {
  const updates: Record<string, any> = {};
  if (fields.name !== undefined) updates.name = fields.name;
  if (fields.active !== undefined) updates.active = fields.active;
  if (Object.keys(updates).length === 0) return;
  await db.from('categories').update(updates).eq('id', id);
}

export async function deleteCategory(id: number): Promise<void> {
  await db.from('categories').update({ active: 0 }).eq('id', id);
}

// ---------- Products ----------

export async function getAllProductsWithVariants(): Promise<any[]> {
  const products = await getProducts();
  return Promise.all(products.map(async (p: any) => {
    const variants = await getProductVariants(p.id);
    return { ...p, variants };
  }));
}

export async function getProducts(): Promise<any[]> {
  const { data } = await db.from('products').select('*').order('category_id, sort_order');
  return data || [];
}

export async function getProductsByCategory(categoryId: number): Promise<any[]> {
  const { data } = await db
    .from('products')
    .select('*')
    .eq('category_id', categoryId)
    .eq('active', 1)
    .eq('unavailable', 0)
    .order('sort_order');
  return data || [];
}

export async function getProductById(id: number): Promise<any | null> {
  const { data } = await db.from('products').select('*').eq('id', id).maybeSingle();
  return data;
}

export async function getProductVariants(productId: number): Promise<any[]> {
  const { data } = await db.from('product_variants').select('*').eq('product_id', productId).order('price');
  return data || [];
}

export async function getVariantByProductAndSize(productId: number, size: string): Promise<any | null> {
  const { data } = await db
    .from('product_variants')
    .select('*')
    .eq('product_id', productId)
    .eq('size', size)
    .maybeSingle();
  return data;
}

export async function createProduct(fields: {
  category_id: number;
  name: string;
  description?: string | null;
  photo_url?: string | null;
  variants?: { size: string; price: number }[];
}): Promise<number> {
  const { data: prodRow, error: prodErr } = await db
    .from('products')
    .insert({
      category_id: fields.category_id,
      name: fields.name,
      description: fields.description ?? null,
      photo_url: fields.photo_url ?? null,
    })
    .select('id')
    .single();
  if (prodErr) throw new Error(`Create product failed: ${prodErr.message}`);
  const pid = Number(prodRow.id);

  if (fields.variants && fields.variants.length > 0) {
    const variantRows = fields.variants.map((v) => ({
      product_id: pid,
      size: v.size,
      price: v.price,
    }));
    const { error: variantErr } = await db.from('product_variants').insert(variantRows);
    if (variantErr) throw new Error(`Create variants failed: ${variantErr.message}`);
  }
  return pid;
}

export async function updateProduct(id: number, fields: Record<string, any>): Promise<void> {
  const updates: Record<string, any> = {};
  if (fields.name !== undefined) updates.name = fields.name;
  if (fields.description !== undefined) updates.description = fields.description;
  if (fields.photo_url !== undefined) updates.photo_url = fields.photo_url;
  if (fields.category_id !== undefined) updates.category_id = fields.category_id;
  if (fields.active !== undefined) updates.active = fields.active;
  if (fields.unavailable !== undefined) updates.unavailable = fields.unavailable;
  if (Object.keys(updates).length === 0) return;
  await db.from('products').update(updates).eq('id', id);
}

export async function deleteProduct(id: number): Promise<void> {
  await db.from('product_variants').delete().eq('product_id', id);
  await db.from('products').delete().eq('id', id);
}

export async function updateVariantPrice(productId: number, size: string, price: number): Promise<void> {
    await db.from('product_variants').update({ price }).eq('product_id', productId).eq('size', size);
}

// ---------- Food Packs ----------

export async function getFoodPacks(): Promise<any[]> {
  const { data } = await db.from('food_packs').select('*').eq('active', 1).order('sort_order, id');
  return data || [];
}

export async function getFoodPackById(id: number): Promise<any | null> {
  const { data } = await db.from('food_packs').select('*').eq('id', id).eq('active', 1).maybeSingle();
  return data;
}

// ---------- Packages ----------

export async function getPackages(): Promise<any[]> {
  const { data } = await db.from('packages').select('*').eq('active', 1).order('is_custom, id');
  return data || [];
}

export async function getPackageById(id: number): Promise<any | null> {
  const { data } = await db.from('packages').select('*').eq('id', id).eq('active', 1).maybeSingle();
  return data;
}

export async function getPackageSlots(packageId: number): Promise<any[]> {
  const { data } = await db.from('package_slots').select('*').eq('package_id', packageId).order('slot_number');
  return data || [];
}

export async function getPackageOptions(slotId: number): Promise<any[]> {
  const { data } = await db
    .from('package_options')
    .select('*, products(name)')
    .eq('slot_id', slotId);
  return (data || []).map((o: any) => ({
    ...o,
    product_name: o.products?.name ?? null,
    products: undefined,
  }));
}

export async function getPackageSlotById(slotId: number): Promise<any | null> {
  const { data } = await db.from('package_slots').select('*').eq('id', slotId).maybeSingle();
  return data;
}

export async function getPackageSlotByNumber(packageId: number, slotNumber: number): Promise<any | null> {
  const { data } = await db
    .from('package_slots')
    .select('*')
    .eq('package_id', packageId)
    .eq('slot_number', slotNumber)
    .maybeSingle();
  return data;
}

export async function getPackageOptionBySlotAndProduct(slotId: number, productId: number): Promise<any | null> {
  const { data } = await db.from('package_options').select('*').eq('slot_id', slotId).eq('product_id', productId).maybeSingle();
  return data;
}

export async function getPackageOptionsForPackage(packageId: number): Promise<any[]> {
  const slots = await getPackageSlots(packageId);
  const out: any[] = [];
  for (const s of slots) {
    const { data } = await db.from('package_options').select('*').eq('slot_id', s.id);
    for (const o of data || []) out.push({ ...o, slot_number: s.slot_number });
  }
  return out;
}

/** All active/in-stock dishes as slot-choice candidates (custom packages). */
export async function getActiveProducts(): Promise<{ product_id: number; product_name: string }[]> {
  const { data } = await db.from('products').select('id, name').eq('active', 1).eq('unavailable', 0).order('name');
  return (data || []).map((p: any) => ({ product_id: p.id, product_name: p.name }));
}

/** Option list for a package slot: [{ product_id, product_name, upgrade_price }]. */
export async function getSlotOptions(slotId: number): Promise<{ product_id: number; product_name: string; upgrade_price: number }[]> {
  const opts = await getPackageOptions(slotId);
  return opts
    .filter((o) => o.product_id != null)
    .map((o) => ({ product_id: o.product_id, product_name: o.product_name ?? 'Unknown', upgrade_price: Number(o.upgrade_price) || 0 }));
}

/** Option list for a custom package (all active dishes + any upgrade overrides). */
export async function getCustomSlotOptions(packageId: number): Promise<{ product_id: number; product_name: string; upgrade_price: number }[]> {
  const opts: { product_id: number; product_name: string; upgrade_price: number }[] =
    (await getActiveProducts()).map((o) => ({ ...o, upgrade_price: 0 }));
  const ups = await getPackageOptionsForPackage(packageId);
  for (const u of ups) {
    const o = opts.find((x) => x.product_id === u.product_id);
    if (o) o.upgrade_price = Number(u.upgrade_price) || 0;
  }
  return opts;
}

export async function getPackageDefaults(packageId: number): Promise<any[]> {
  const { data } = await db.from('package_slots').select('*').eq('package_id', packageId).order('slot_number');
  return data || [];
}

// ---------- Orders ----------

export async function getOrdersToday(): Promise<any[]> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await db.from('orders').select('*').gte('created_at', today + 'T00:00:00').order('id');
  return data || [];
}

export async function getOrdersByStatus(status: string): Promise<any[]> {
  const { data } = await db.from('orders').select('*').eq('status', status).order('id');
  return data || [];
}

export async function getOrdersByDateRange(start: string, end: string): Promise<any[]> {
  const { data } = await db.from('orders').select('*').gte('created_at', start).lt('created_at', end);
  return data || [];
}

export async function getOrdersByCustomer(psid: string): Promise<any[]> {
  const { data } = await db.from('orders').select('*').eq('customer_psid', psid).order('id', { ascending: false });
  return data || [];
}

export async function getOrderById(id: number): Promise<any | null> {
  const { data } = await db.from('orders').select('*').eq('id', id).maybeSingle();
  return data;
}

export async function getOrderByNumber(orderNumber: string): Promise<any | null> {
  const { data } = await db.from('orders').select('*').eq('order_number', orderNumber).maybeSingle();
  return data;
}

export async function createOrder(order: Record<string, any>): Promise<number> {
  const { data, error } = await db.from('orders').insert(order).select('id').single();
  if (error) throw new Error(`Create order failed: ${error.message}`);
  return Number(data.id);
}

export async function updateOrder(id: number, fields: Record<string, any>): Promise<void> {
  const { error } = await db.from('orders').update(fields).eq('id', id);
  if (error) throw new Error(`Update order failed: ${error.message}`);
}

export async function cancelOrder(id: number): Promise<void> {
  await db.from('orders').update({ status: 'CANCELLED' }).eq('id', id);
}

// ---------- Cart Items ----------

export async function getCartItems(psid: string): Promise<any[]> {
  const cartId = await getCartId(psid);
  if (!cartId) return [];
  const { data } = await db.from('cart_items').select('*').eq('cart_id', cartId);
  return data || [];
}

export async function getCartId(psid: string): Promise<number | null> {
  const { data } = await db.from('carts').select('id').eq('psid', psid).maybeSingle();
  return data ? Number(data.id) : null;
}

export async function getOrCreateCartId(psid: string): Promise<number> {
  const existing = await getCartId(psid);
  if (existing) return existing;
  const { data, error } = await db.from('carts').insert({ psid }).select('id').single();
  if (error) throw new Error(`Create cart failed: ${error.message}`);
  return Number(data.id);
}

export async function addCartItem(psid: string, item: Record<string, any>): Promise<void> {
  const cartId = await getOrCreateCartId(psid);
  await db.from('cart_items').insert({ cart_id: cartId, ...item });
}

export async function updateCartItemQuantity(itemId: number, quantity: number): Promise<void> {
  await db.from('cart_items').update({ quantity }).eq('id', itemId);
}

export async function deleteCartItem(itemId: number): Promise<void> {
  await db.from('cart_items').delete().eq('id', itemId);
}

export async function clearCart(psid: string): Promise<void> {
  const cartId = await getCartId(psid);
  if (!cartId) return;
  await db.from('cart_items').delete().eq('cart_id', cartId);
}

export async function getCartItemById(itemId: number): Promise<any | null> {
  const { data } = await db.from('cart_items').select('*').eq('id', itemId).maybeSingle();
  return data;
}

// ---------- Reservations ----------

export async function getReservationsByDate(date: string): Promise<any[]> {
  const { data } = await db
    .from('reservations')
    .select('*')
    .eq('res_date', date)
    .neq('status', 'CANCELLED')
    .order('time_slot');
  return data || [];
}

export async function getReservationById(id: number): Promise<any | null> {
  const { data } = await db.from('reservations').select('*').eq('id', id).maybeSingle();
  return data;
}

export async function createReservation(fields: Record<string, any>): Promise<number> {
  const { data, error } = await db.from('reservations').insert(fields).select('id').single();
  if (error) throw new Error(`Create reservation failed: ${error.message}`);
  return Number(data.id);
}

export async function updateReservation(id: number, fields: Record<string, any>): Promise<void> {
  await db.from('reservations').update(fields).eq('id', id);
}

export async function cancelReservation(id: number): Promise<void> {
  await db.from('reservations').update({ status: 'CANCELLED' }).eq('id', id);
}

export async function getReservationsByCustomer(psid: string): Promise<any[]> {
  const { data } = await db
    .from('reservations')
    .select('*')
    .eq('customer_psid', psid)
    .order('id', { ascending: false });
  return data || [];
}

// ---------- Slots ----------

export async function getSlotAvailability(date: string): Promise<any[]> {
  const { data } = await db.from('slots').select('*').eq('slot_date', date).order('sort_order');
  return data || [];
}

export async function isDateOpen(date: string): Promise<boolean> {
  const { count } = await db.from('slots').select('*', { count: 'exact' }).eq('slot_date', date);
  return count !== null && count > 0;
}

// ---------- Admins ----------

export async function getAdminById(id: number): Promise<any | null> {
  const { data } = await db.from('admins').select('*').eq('id', id).maybeSingle();
  return data;
}

export async function getAdminBySub(sub: string): Promise<any | null> {
  const { data } = await db.from('admins').select('*').eq('sub', sub).maybeSingle();
  return data;
}

export async function getAllAdmins(): Promise<any[]> {
  const { data } = await db.from('admins').select('*').order('id');
  return data || [];
}

export async function createAdmin(fields: Record<string, any>): Promise<number> {
  const { data, error } = await db.from('admins').insert(fields).select('id').single();
  if (error) throw new Error(`Create admin failed: ${error.message}`);
  return Number(data.id);
}

export async function updateAdmin(id: number, fields: Record<string, any>): Promise<void> {
  await db.from('admins').update(fields).eq('id', id);
}

export async function deleteAdmin(id: number): Promise<void> {
  await db.from('admins').delete().eq('id', id);
}

export async function countAdminsWithRole(role: string): Promise<number> {
  const { count } = await db.from('admins').select('*', { count: 'exact' }).eq('role', role);
  return count || 0;
}

// ---------- App Settings ----------

export async function getAllSettings(): Promise<Record<string, string>> {
  const { data } = await db.from('app_settings').select('key, value');
  const settings: Record<string, string> = {};
  if (data) for (const row of data) settings[row.key] = row.value;
  return settings;
}

export async function getSetting(key: string): Promise<string | null> {
  const { data } = await db.from('app_settings').select('value').eq('key', key).maybeSingle();
  return data?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  const existing = await db.from('app_settings').select('key').eq('key', key).maybeSingle();
  if (existing) {
    await db.from('app_settings').update({ value, updated_at: now }).eq('key', key);
  } else {
    await db.from('app_settings').insert({ key, value, updated_at: now });
  }
}

// ---------- Push Subscriptions ----------

export async function storeSubscription(sub: { endpoint: string; p256dh: string; auth: string }, userAgent?: string): Promise<void> {
  const { error } = await db.from('push_subscriptions').insert({
    endpoint: sub.endpoint,
    p256dh: sub.p256dh,
    auth: sub.auth,
    user_agent: userAgent || null,
  });
  if (error) throw new Error(`Store subscription failed: ${error.message}`);
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await db.from('push_subscriptions').delete().eq('endpoint', endpoint);
}

export async function getSubscriptions(): Promise<any[]> {
  const { data } = await db.from('push_subscriptions').select('*');
  return data || [];
}

// ---------- Order Items ----------

export async function createOrderItem(orderId: number, fields: Record<string, any>): Promise<void> {
  await db.from('order_items').insert({ order_id: orderId, ...fields });
}

export async function getOrderItems(orderId: number): Promise<any[]> {
  const { data } = await db.from('order_items').select('*').eq('order_id', orderId);
  return data || [];
}

// ---------- Package Selections (slot choices) ----------

export async function createCartItemSlotChoice(cartItemId: number, productId: number, slotNumber: number): Promise<void> {
  await db.from('cart_item_slot_choices').insert({ cart_item_id: cartItemId, product_id: productId, slot_number: slotNumber });
}

// ---------- Package Orders ----------

export async function createPackageOrder(orderId: number, fields: Record<string, any>): Promise<void> {
  await db.from('package_orders').insert({ order_id: orderId, ...fields });
}



