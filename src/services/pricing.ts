import { supa } from '../db/supabase';

export interface PricingResult {
  unit_price: number;
  lines: { label: string; amount: number }[];
}

export interface SlotChoice { slot_number: number; product_id: number; size?: string; }

/** Size upgrade charged per dish for custom-package slots without an explicit option row. */
export const CUSTOM_DEFAULT_SIZE_UPGRADE = 100;

/**
 * Charged package price before the additional discount: base + upgrades.
 * The admin-set discount is an ADDITIONAL discount applied at the end, on top
 * of the whole package price (base + upgrades) — see pricePackage.
 */
export function netPackagePrice(pkg: { base_price: number; discount?: number | null }): number {
  return Math.max(0, (pkg.base_price || 0) - (pkg.discount || 0));
}

/**
 * Server-side authoritative pricing. Never trusts client prices.
 * Prices stored as integer pesos (or centavos — consistent usage).
 */
export async function priceProduct(productId: number, size: string): Promise<number> {
  const { data } = await supa().from('product_variants').select('price').eq('product_id', productId).eq('size', size).single();
  if (!data) throw new Error('Invalid product or size');
  return data.price;
}

/**
 * Accept both the array form [{slot_number, product_id}] and the legacy
 * object form {slot_number: product_id} used by older carts.
 */
export function normalizeChoices(slotChoices: any): SlotChoice[] {
  if (Array.isArray(slotChoices)) {
    return slotChoices
      .map((c: any) => ({ slot_number: Number(c.slot_number), product_id: Number(c.product_id), size: c.size }))
      .filter((c) => Number.isFinite(c.slot_number) && Number.isFinite(c.product_id));
  }
  if (slotChoices && typeof slotChoices === 'object') {
    return Object.entries(slotChoices).map(([k, v]) => ({ slot_number: Number(k), product_id: Number(v) }));
  }
  return [];
}

/** Pre-selected dish per slot: the is_default option wins, otherwise the first option. */
export async function packageDefaults(packageId: number): Promise<SlotChoice[]> {
  const { data: slots } = await supa().from('package_slots').select('id, slot_number').eq('package_id', packageId).order('slot_number');
  const out: SlotChoice[] = [];
  for (const s of slots || []) {
    const { data: opt } = await supa().from('package_options').select('product_id').eq('slot_id', s.id).order('is_default', { ascending: false }).order('id').limit(1).maybeSingle();
    if (opt) out.push({ slot_number: s.slot_number, product_id: opt.product_id });
  }
  return out;
}

/**
 * Base price of a package = sum of the price of each slot's pre-selected (default)
 * dish. Not manually editable — derived from the dishes in the package.
 */
export async function computePackageBasePrice(packageId: number): Promise<number> {
  const { data: slots } = await supa().from('package_slots').select('id').eq('package_id', packageId).order('slot_number');
  let sum = 0;
  for (const s of slots || []) {
    const { data: opt } = await supa().from('package_options').select('product_id').eq('slot_id', s.id).order('is_default', { ascending: false }).order('id').limit(1).maybeSingle();
    if (!opt) continue;
    const { data: v } = await supa().from('product_variants').select('price').eq('product_id', opt.product_id).order('price').limit(1).maybeSingle();
    sum += Number(v?.price) || 0;
  }
  return sum;
}

/** Surcharge for a single package slot choice (upgrade + optional size upgrade). */
export async function choiceUpgrade(packageId: number, slotNumber: number, productId: number, size?: string): Promise<number> {
  const { data: slot } = await supa().from('package_slots').select('id').eq('package_id', packageId).eq('slot_number', slotNumber).single();
  if (!slot) throw new Error(`Invalid slot ${slotNumber}`);
  const { data: opt } = await supa().from('package_options').select('*').eq('slot_id', slot.id).eq('product_id', productId).maybeSingle();
  if (!opt) {
    // Custom packages allow every active dish; default size upgrade applies unless configured.
    const { data: pkg } = await supa().from('packages').select('is_custom').eq('id', packageId).single();
    if (pkg?.is_custom) {
      const { data: prod } = await supa().from('products').select('id').eq('id', productId).eq('active', 1).maybeSingle();
      if (!prod) throw new Error('Product not allowed in this slot');
      return size === 'L' ? CUSTOM_DEFAULT_SIZE_UPGRADE : 0;
    }
    throw new Error('Product not allowed in this slot');
  }
  let extra = opt.upgrade_price || 0;
  if (size === 'L') {
    // Admin-configured size upgrade wins; fall back to the real menu price
    // difference (L variant − M variant) when none is configured, so Large
    // never prices the same as Medium by accident.
    let sizeExtra = opt.size_upgrade_price || 0;
    if (!sizeExtra) {
      const { data: variants } = await supa().from('product_variants').select('size, price').eq('product_id', productId);
      const l = variants?.find((v: any) => v.size === 'L');
      const m = variants?.find((v: any) => v.size === 'M');
      sizeExtra = Math.max(0, Number(l?.price || 0) - Number(m?.price || 0));
    }
    extra += sizeExtra;
  }
  return extra;
}

/** Price a package cart item given slot choices (array or legacy object) and the package size. */
export async function pricePackage(packageId: number, slotChoices: any, packageSize?: string): Promise<{ total: number; breakdown: { label: string; amount: number }[] }> {
  const { data: pkg } = await supa().from('packages').select('*').eq('id', packageId).eq('active', 1).single();
  if (!pkg) throw new Error('Invalid package');
  const breakdown: { label: string; amount: number }[] = [{ label: `${pkg.name} base`, amount: pkg.base_price }];
  let total = pkg.base_price || 0;

  const { data: slots } = await supa().from('package_slots').select('*').eq('package_id', packageId);
  const choices = normalizeChoices(slotChoices);
  if (choices.length !== pkg.selections) throw new Error(`Package requires ${pkg.selections} selections`);

  for (const choice of choices) {
    const slot = (slots || []).find((s: any) => s.slot_number === choice.slot_number);
    if (!slot) throw new Error(`Invalid slot ${choice.slot_number}`);
    const size = choice.size || packageSize;
    const extra = await choiceUpgrade(packageId, choice.slot_number, choice.product_id, size);
    const { data: prod } = await supa().from('products').select('name').eq('id', choice.product_id).maybeSingle();
    if (extra > 0) breakdown.push({ label: `${prod?.name ?? 'Dish'}${size ? ' ' + size : ''} upgrade`, amount: extra });
    total += extra;
  }
  // Admin-set additional discount applies on top of the FULL package price
  // (base + upgrades), never dropping below zero.
  if ((pkg.discount || 0) > 0) {
    const applied = Math.min(pkg.discount, Math.max(0, total));
    breakdown.push({ label: `${pkg.name} additional discount`, amount: -applied });
    total = Math.max(0, total - applied);
  }
  return { total, breakdown };
}

/** Server-side authoritative price of a food pack (fixed-price bundle). */
export async function priceFoodPack(foodPackId: number): Promise<{ price: number; name: string }> {
  const { data: pack } = await supa().from('food_packs').select('id, name, price').eq('id', foodPackId).eq('active', 1).single();
  if (!pack) throw new Error('Invalid food pack');
  return { price: Number(pack.price) || 0, name: pack.name };
}

/** Compute total for a cart: items = [{product_id?, package_id?, food_pack_id?, variant_size?, quantity, slot_choices?}]
 *  Cart total = sum of item lines − package discounts (discount applies per discounted package unit). */
export async function computeCartTotals(items: any[], deliveryFee = 0): Promise<{ subtotal: number; delivery: number; discount: number; total: number; breakdown: any[] }> {
  const breakdown: any[] = [];
  let subtotal = 0;
  let discount = 0;
  for (const item of items) {
    if (item.food_pack_id) {
      const { price, name } = await priceFoodPack(item.food_pack_id);
      breakdown.push({ label: `${name} (food pack) x${item.quantity}`, amount: price * item.quantity });
      subtotal += price * item.quantity;
    } else if (item.package_id) {
      const { total, breakdown: bd } = await pricePackage(item.package_id, item.slot_choices, item.variant_size);
      // Scale the per-unit breakdown to the quantity so lines sum to the subtotal
      for (const line of bd) {
        breakdown.push({ ...line, amount: line.amount * item.quantity });
        if (line.amount < 0) discount += -line.amount * item.quantity;
      }
      subtotal += total * item.quantity;
    } else {
      const price = await priceProduct(item.product_id, item.variant_size);
      const { data: prod } = await supa().from('products').select('name').eq('id', item.product_id).maybeSingle();
      breakdown.push({ label: `${prod?.name || ''} ${item.variant_size} x${item.quantity}`, amount: price * item.quantity });
      subtotal += price * item.quantity;
    }
  }
  // subtotal already has discounts baked in (package lines are net); total = items − discount + delivery
  const total = subtotal + deliveryFee;
  return { subtotal, delivery: deliveryFee, discount, total, breakdown };
}