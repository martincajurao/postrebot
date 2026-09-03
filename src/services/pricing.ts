import { db } from '../db/database';

export interface PricingResult {
  unit_price: number;
  lines: { label: string; amount: number }[];
}

export interface SlotChoice { slot_number: number; product_id: number; size?: string; }

/** Size upgrade charged per dish for custom-package slots without an explicit option row. */
export const CUSTOM_DEFAULT_SIZE_UPGRADE = 100;

/** Charged package price: base minus any combo discount (never below zero). */
export function netPackagePrice(pkg: { base_price: number; discount?: number | null }): number {
  return Math.max(0, (pkg.base_price || 0) - (pkg.discount || 0));
}

/**
 * Server-side authoritative pricing. Never trusts client prices.
 * Prices stored as integer pesos (or centavos — consistent usage).
 */
export function priceProduct(productId: number, size: string): number {
  const row = db.prepare(
    'SELECT price FROM product_variants WHERE product_id = ? AND size = ?'
  ).get(productId, size) as any;
  if (!row) throw new Error('Invalid product or size');
  return row.price;
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
export function packageDefaults(packageId: number): SlotChoice[] {
  const slots = db.prepare('SELECT * FROM package_slots WHERE package_id = ? ORDER BY slot_number').all(packageId) as any[];
  const out: SlotChoice[] = [];
  for (const s of slots) {
    const opt = db.prepare(
      'SELECT product_id FROM package_options WHERE slot_id = ? ORDER BY is_default DESC, id LIMIT 1'
    ).get(s.id) as any;
    if (opt) out.push({ slot_number: s.slot_number, product_id: opt.product_id });
  }
  return out;
}

/**
 * Base price of a package = sum of the price of each slot's pre-selected (default)
 * dish. Not manually editable — derived from the dishes in the package.
 */
export function computePackageBasePrice(packageId: number): number {
  const slots = db.prepare('SELECT id FROM package_slots WHERE package_id = ? ORDER BY slot_number').all(packageId) as any[];
  let sum = 0;
  for (const s of slots) {
    const opt = db.prepare(
      'SELECT product_id FROM package_options WHERE slot_id = ? ORDER BY is_default DESC, id LIMIT 1'
    ).get(s.id) as any;
    if (!opt) continue;
    const v = db.prepare('SELECT MIN(price) AS p FROM product_variants WHERE product_id = ?').get(opt.product_id) as any;
    sum += Number(v?.p) || 0;
  }
  return sum;
}

/** Surcharge for a single package slot choice (upgrade + optional size upgrade). */
export function choiceUpgrade(packageId: number, slotNumber: number, productId: number, size?: string): number {
  const slot = db.prepare('SELECT id FROM package_slots WHERE package_id = ? AND slot_number = ?')
    .get(packageId, slotNumber) as any;
  if (!slot) throw new Error(`Invalid slot ${slotNumber}`);
  const opt = db.prepare('SELECT * FROM package_options WHERE slot_id = ? AND product_id = ?')
    .get(slot.id, productId) as any;
  if (!opt) {
    // Custom packages allow every active dish; default size upgrade applies unless configured.
    const pkg = db.prepare('SELECT is_custom FROM packages WHERE id = ?').get(packageId) as any;
    if (pkg?.is_custom) {
      const prod = db.prepare('SELECT id FROM products WHERE id = ? AND active = 1').get(productId) as any;
      if (!prod) throw new Error('Product not allowed in this slot');
      return size === 'L' ? CUSTOM_DEFAULT_SIZE_UPGRADE : 0;
    }
    throw new Error('Product not allowed in this slot');
  }
  let extra = opt.upgrade_price || 0;
  if (size === 'L') extra += opt.size_upgrade_price || 0;
  return extra;
}

/** Price a package cart item given slot choices (array or legacy object) and the package size. */
export function pricePackage(packageId: number, slotChoices: any, packageSize?: string): { total: number; breakdown: { label: string; amount: number }[] } {
  const pkg = db.prepare('SELECT * FROM packages WHERE id = ? AND active = 1').get(packageId) as any;
  if (!pkg) throw new Error('Invalid package');
  const breakdown: { label: string; amount: number }[] = [{ label: `${pkg.name} base`, amount: pkg.base_price }];
  if ((pkg.discount || 0) > 0) breakdown.push({ label: `${pkg.name} discount`, amount: -(pkg.discount) });
  let total = netPackagePrice(pkg);

  const slots = db.prepare('SELECT * FROM package_slots WHERE package_id = ?').all(packageId) as any[];
  const choices = normalizeChoices(slotChoices);
  if (choices.length !== pkg.selections) throw new Error(`Package requires ${pkg.selections} selections`);

  for (const choice of choices) {
    const slot = slots.find((s: any) => s.slot_number === choice.slot_number);
    if (!slot) throw new Error(`Invalid slot ${choice.slot_number}`);
    const size = choice.size || packageSize;
    const extra = choiceUpgrade(packageId, choice.slot_number, choice.product_id, size);
    const prod = db.prepare('SELECT name FROM products WHERE id = ?').get(choice.product_id) as any;
    if (extra > 0) breakdown.push({ label: `${prod?.name ?? 'Dish'}${size ? ' ' + size : ''} upgrade`, amount: extra });
    total += extra;
  }
  return { total, breakdown };
}

/** Compute total for a cart: items = [{product_id?, package_id?, variant_size?, quantity, slot_choices?}] */
export function computeCartTotals(items: any[], deliveryFee = 0): { subtotal: number; delivery: number; total: number; breakdown: any[] } {
  const breakdown: any[] = [];
  let subtotal = 0;
  for (const item of items) {
    if (item.package_id) {
      const { total, breakdown: bd } = pricePackage(item.package_id, item.slot_choices, item.variant_size);
      breakdown.push(...bd);
      subtotal += total * item.quantity;
    } else {
      const price = priceProduct(item.product_id, item.variant_size);
      const prod = db.prepare('SELECT name FROM products WHERE id = ?').get(item.product_id) as any;
      breakdown.push({ label: `${prod.name} ${item.variant_size} x${item.quantity}`, amount: price * item.quantity });
      subtotal += price * item.quantity;
    }
  }
  const total = subtotal + deliveryFee;
  return { subtotal, delivery: deliveryFee, total, breakdown };
}
