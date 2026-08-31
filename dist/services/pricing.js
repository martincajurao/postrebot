"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CUSTOM_DEFAULT_SIZE_UPGRADE = void 0;
exports.netPackagePrice = netPackagePrice;
exports.priceProduct = priceProduct;
exports.normalizeChoices = normalizeChoices;
exports.packageDefaults = packageDefaults;
exports.choiceUpgrade = choiceUpgrade;
exports.pricePackage = pricePackage;
exports.computeCartTotals = computeCartTotals;
const database_1 = require("../db/database");
/** Size upgrade charged per dish for custom-package slots without an explicit option row. */
exports.CUSTOM_DEFAULT_SIZE_UPGRADE = 100;
/** Charged package price: base minus any combo discount (never below zero). */
function netPackagePrice(pkg) {
    return Math.max(0, (pkg.base_price || 0) - (pkg.discount || 0));
}
/**
 * Server-side authoritative pricing. Never trusts client prices.
 * Prices stored as integer pesos (or centavos — consistent usage).
 */
function priceProduct(productId, size) {
    const row = database_1.db.prepare('SELECT price FROM product_variants WHERE product_id = ? AND size = ?').get(productId, size);
    if (!row)
        throw new Error('Invalid product or size');
    return row.price;
}
/**
 * Accept both the array form [{slot_number, product_id}] and the legacy
 * object form {slot_number: product_id} used by older carts.
 */
function normalizeChoices(slotChoices) {
    if (Array.isArray(slotChoices)) {
        return slotChoices
            .map((c) => ({ slot_number: Number(c.slot_number), product_id: Number(c.product_id), size: c.size }))
            .filter((c) => Number.isFinite(c.slot_number) && Number.isFinite(c.product_id));
    }
    if (slotChoices && typeof slotChoices === 'object') {
        return Object.entries(slotChoices).map(([k, v]) => ({ slot_number: Number(k), product_id: Number(v) }));
    }
    return [];
}
/** Pre-selected dish per slot: the is_default option wins, otherwise the first option. */
function packageDefaults(packageId) {
    const slots = database_1.db.prepare('SELECT * FROM package_slots WHERE package_id = ? ORDER BY slot_number').all(packageId);
    const out = [];
    for (const s of slots) {
        const opt = database_1.db.prepare('SELECT product_id FROM package_options WHERE slot_id = ? ORDER BY is_default DESC, id LIMIT 1').get(s.id);
        if (opt)
            out.push({ slot_number: s.slot_number, product_id: opt.product_id });
    }
    return out;
}
/** Surcharge for a single package slot choice (upgrade + optional size upgrade). */
function choiceUpgrade(packageId, slotNumber, productId, size) {
    const slot = database_1.db.prepare('SELECT id FROM package_slots WHERE package_id = ? AND slot_number = ?')
        .get(packageId, slotNumber);
    if (!slot)
        throw new Error(`Invalid slot ${slotNumber}`);
    const opt = database_1.db.prepare('SELECT * FROM package_options WHERE slot_id = ? AND product_id = ?')
        .get(slot.id, productId);
    if (!opt) {
        // Custom packages allow every active dish; default size upgrade applies unless configured.
        const pkg = database_1.db.prepare('SELECT is_custom FROM packages WHERE id = ?').get(packageId);
        if (pkg?.is_custom) {
            const prod = database_1.db.prepare('SELECT id FROM products WHERE id = ? AND active = 1').get(productId);
            if (!prod)
                throw new Error('Product not allowed in this slot');
            return size === 'L' ? exports.CUSTOM_DEFAULT_SIZE_UPGRADE : 0;
        }
        throw new Error('Product not allowed in this slot');
    }
    let extra = opt.upgrade_price || 0;
    if (size === 'L')
        extra += opt.size_upgrade_price || 0;
    return extra;
}
/** Price a package cart item given slot choices (array or legacy object) and the package size. */
function pricePackage(packageId, slotChoices, packageSize) {
    const pkg = database_1.db.prepare('SELECT * FROM packages WHERE id = ? AND active = 1').get(packageId);
    if (!pkg)
        throw new Error('Invalid package');
    const breakdown = [{ label: `${pkg.name} base`, amount: pkg.base_price }];
    if ((pkg.discount || 0) > 0)
        breakdown.push({ label: `${pkg.name} discount`, amount: -(pkg.discount) });
    let total = netPackagePrice(pkg);
    const slots = database_1.db.prepare('SELECT * FROM package_slots WHERE package_id = ?').all(packageId);
    const choices = normalizeChoices(slotChoices);
    if (choices.length !== pkg.selections)
        throw new Error(`Package requires ${pkg.selections} selections`);
    for (const choice of choices) {
        const slot = slots.find((s) => s.slot_number === choice.slot_number);
        if (!slot)
            throw new Error(`Invalid slot ${choice.slot_number}`);
        const size = choice.size || packageSize;
        const extra = choiceUpgrade(packageId, choice.slot_number, choice.product_id, size);
        const prod = database_1.db.prepare('SELECT name FROM products WHERE id = ?').get(choice.product_id);
        if (extra > 0)
            breakdown.push({ label: `${prod?.name ?? 'Dish'}${size ? ' ' + size : ''} upgrade`, amount: extra });
        total += extra;
    }
    return { total, breakdown };
}
/** Compute total for a cart: items = [{product_id?, package_id?, variant_size?, quantity, slot_choices?}] */
function computeCartTotals(items, deliveryFee = 0) {
    const breakdown = [];
    let subtotal = 0;
    for (const item of items) {
        if (item.package_id) {
            const { total, breakdown: bd } = pricePackage(item.package_id, item.slot_choices, item.variant_size);
            breakdown.push(...bd);
            subtotal += total * item.quantity;
        }
        else {
            const price = priceProduct(item.product_id, item.variant_size);
            const prod = database_1.db.prepare('SELECT name FROM products WHERE id = ?').get(item.product_id);
            breakdown.push({ label: `${prod.name} ${item.variant_size} x${item.quantity}`, amount: price * item.quantity });
            subtotal += price * item.quantity;
        }
    }
    const total = subtotal + deliveryFee;
    return { subtotal, delivery: deliveryFee, total, breakdown };
}
