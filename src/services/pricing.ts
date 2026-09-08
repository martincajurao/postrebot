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
 * Volume-based auto-discount for "Build Your Own" custom packages, based on
 * the sum of the selected dishes' M-size menu prices (size upgrades excluded):
 *   sum >= 5000 → 1100, sum >= 4300 → 1000, sum >= 3000 → 700, else 0.
 * Mirrors the webview's autoDiscount() so checkout matches the displayed price.
 */
function autoDiscount(itemsSum: number): number {
  if (itemsSum >= 5000) return 1100;
  if (itemsSum >= 4300) return 1000;
  if (itemsSum >= 3000) return 700;
  return 0;
}

/**
 * Server-side authoritative pricing. Never trusts client prices.
 * Prices stored as integer pesos (or centavos — consistent usage).
 */
export async function priceProduct(productId: number, size?: string): Promise<number> {
  let query = supa().from('product_variants').select('price').eq('product_id', productId);
  if (size) {
    query = query.eq('size', size);
  }
  const { data } = await query.order('price').limit(1).maybeSingle();
  if (!data) {
    const { data: fallback } = await supa().from('product_variants').select('price').eq('product_id', productId).limit(1).maybeSingle();
    if (fallback) return fallback.price;
    throw new Error('Invalid product or size');
  }
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
    // Prefer the M variant (falling back to the cheapest) so base = sum of the
    // default dishes' M menu prices — matching the client's sum(items) −
    // discount formula and choiceUpgrade's relative surcharges.
    const { data: variants } = await supa().from('product_variants').select('size, price').eq('product_id', opt.product_id);
    const m = variants?.find((v: any) => String(v.size).toUpperCase() === 'M') || (variants && variants[0]);
    sum += Number(m?.price) || 0;
  }
  return sum;
}

/** Surcharge for a single package slot choice (upgrade + optional size upgrade). */
/** M-size menu price of a dish (cheapest variant as fallback) — mirrors the webview's productMenuPriceM. */
async function menuPriceM(productId: number): Promise<number> {
  const { data: variants } = await supa().from('product_variants').select('size, price').eq('product_id', productId);
  const m = variants?.find((v: any) => String(v.size).toUpperCase() === 'M') || (variants && variants[0]);
  return Number(m?.price) || 0;
}

export async function choiceUpgrade(packageId: number, slotNumber: number, productId: number, size?: string): Promise<number> {
  const { data: slot } = await supa().from('package_slots').select('id').eq('package_id', packageId).eq('slot_number', slotNumber).single();
  if (!slot) throw new Error(`Invalid slot ${slotNumber}`);
  const { data: opt } = await supa().from('package_options').select('*').eq('slot_id', slot.id).eq('product_id', productId).maybeSingle();
  if (!opt) {
    // Custom packages allow every active dish and have no per-slot default, so
    // the dish is charged at its full M menu price (plus the Large difference),
    // mirroring the webview's custom-package pricing.
    const { data: pkg } = await supa().from('packages').select('is_custom').eq('id', packageId).single();
    if (pkg?.is_custom) {
      const { data: prod } = await supa().from('products').select('id').eq('id', productId).eq('active', 1).maybeSingle();
      if (!prod) throw new Error('Product not allowed in this slot');
      return (await menuPriceM(productId)) + (size === 'L' ? await variantDiffL(productId) : 0);
    }
    throw new Error('Product not allowed in this slot');
  }
  // Surcharge = price difference vs the slot's default dish + admin upgrade.
  // The base price already covers the default dish, so the package total works
  // out to sum(selected dish menu prices) − package discount.
  const { data: defOpt } = await supa().from('package_options').select('product_id').eq('slot_id', slot.id)
    .order('is_default', { ascending: false }).order('id').limit(1).maybeSingle();
  let extra = Number(opt.upgrade_price) || 0;
  if (defOpt) {
    const chosenM = await menuPriceM(productId);
    const defM = Number(defOpt.product_id) === productId ? chosenM : await menuPriceM(defOpt.product_id);
    extra += Math.max(0, chosenM - defM);
  }
  if (size === 'L') {
    // Admin-configured size upgrade wins; fall back to the real menu price
    // difference (L variant − M variant) when none is configured, so Large
    // never prices the same as Medium by accident.
    let sizeExtra = opt.size_upgrade_price || 0;
    if (!sizeExtra) sizeExtra = await variantDiffL(productId);
    extra += sizeExtra;
  }
  return extra;
}

/** Real menu price difference (L variant − M variant), never negative. */
async function variantDiffL(productId: number): Promise<number> {
  const { data: variants } = await supa().from('product_variants').select('size, price').eq('product_id', productId);
  const l = variants?.find((v: any) => String(v.size).toUpperCase() === 'L');
  const m = variants?.find((v: any) => String(v.size).toUpperCase() === 'M');
  return Math.max(0, Number(l?.price || 0) - Number(m?.price || 0));
}

/** Price a package cart item given slot choices (array or legacy object) and the package size. */
export async function pricePackage(packageId: number, slotChoices: any, packageSize?: string): Promise<{ total: number; breakdown: { label: string; amount: number }[] }> {
  const { data: pkg } = await supa().from('packages').select('*').eq('id', packageId).eq('active', 1).single();
  if (!pkg) throw new Error('Invalid package');
  const breakdown: { label: string; amount: number }[] = [{ label: `${pkg.name} base`, amount: pkg.base_price }];
  let total = pkg.base_price || 0;

  const { data: slots } = await supa().from('package_slots').select('*').eq('package_id', packageId);
  let choices = normalizeChoices(slotChoices);

  // If slot choices were not provided or incomplete, fill with default slot choices
  if (choices.length === 0) {
    const defaults = await packageDefaults(packageId);
    if (defaults && defaults.length > 0) {
      choices = defaults;
    }
  } else if (choices.length < (pkg.selections || 0)) {
    const defaults = await packageDefaults(packageId);
    for (const d of defaults) {
      if (!choices.some(c => c.slot_number === d.slot_number)) {
        choices.push(d);
      }
    }
  }

  for (const choice of choices) {
    const slot = (slots || []).find((s: any) => s.slot_number === choice.slot_number);
    if (!slot) continue;
    const size = choice.size || packageSize;
    let extra = 0;
    try {
      extra = await choiceUpgrade(packageId, choice.slot_number, choice.product_id, size);
    } catch {
      extra = 0;
    }
    const { data: prod } = await supa().from('products').select('name').eq('id', choice.product_id).maybeSingle();
    if (extra > 0) breakdown.push({ label: `${prod?.name ?? 'Dish'}${size ? ' ' + size : ''} upgrade`, amount: extra });
    total += extra;
  }
  // Custom ("Build Your Own") packages use a volume-based auto-discount
  // derived from the sum of the selected dishes' M-size menu prices;
  // fixed packages use the admin-set pkg.discount.
  let discount = pkg.discount || 0;
  if (pkg.is_custom) {
    let itemsSum = 0;
    for (const choice of choices) {
      itemsSum += await menuPriceM(choice.product_id);
    }
    discount = autoDiscount(itemsSum);
  }
  if (discount > 0) {
    const applied = Math.min(discount, Math.max(0, total));
    breakdown.push({ label: pkg.is_custom ? `${pkg.name} volume discount` : `${pkg.name} additional discount`, amount: -applied });
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
 *  Formula: subtotal = sum of menu-item prices (before discounts) · discount = sum of discounts ·
 *  total = subtotal − discount + delivery. The package discount is capped per package unit,
 *  never dropping a line below zero. */
export async function computeCartTotals(items: any[], deliveryFee = 0): Promise<{ subtotal: number; delivery: number; discount: number; total: number; breakdown: any[] }> {
  const breakdown: any[] = [];
  let subtotal = 0;
  let discount = 0;
  for (const item of items) {
    try {
      if (item.food_pack_id) {
        const { price, name } = await priceFoodPack(item.food_pack_id);
        breakdown.push({ label: `${name} (food pack) x${item.quantity}`, amount: price * item.quantity });
        subtotal += price * item.quantity;
      } else if (item.package_id) {
        const { total, breakdown: bd } = await pricePackage(item.package_id, item.slot_choices, item.variant_size);
        // pricePackage returns the NET per-unit amount (base + upgrades − discount)
        // plus a negative discount line. Rebuild the GROSS item price so the cart
        // reads: sum(menu items) − sum(discounts) = total.
        const perUnitDiscount = bd.filter((l: any) => l.amount < 0).reduce((s: number, l: any) => s + (-l.amount), 0);
        const grossPerUnit = total + perUnitDiscount;
        // Scale the per-unit breakdown to the quantity (positive lines are gross
        // components, the negative line is the discount — they sum to the net amount).
        for (const line of bd) {
          breakdown.push({ ...line, amount: line.amount * item.quantity });
        }
        subtotal += grossPerUnit * item.quantity;
        discount += perUnitDiscount * item.quantity;
      } else if (item.product_id) {
        const price = await priceProduct(item.product_id, item.variant_size);
        const { data: prod } = await supa().from('products').select('name').eq('id', item.product_id).maybeSingle();
        breakdown.push({ label: `${prod?.name || ''} ${item.variant_size || ''} x${item.quantity}`.trim(), amount: price * item.quantity });
        subtotal += price * item.quantity;
      }
    } catch (err: any) {
      console.warn(`[computeCartTotals] Could not price item #${item.id}:`, err?.message || err);
    }
  }
  // total = sum(menu items) − sum(discounts) + delivery
  const total = Math.max(0, subtotal - discount) + deliveryFee;
  return { subtotal, delivery: deliveryFee, discount, total, breakdown };
}