"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOrCreateCart = getOrCreateCart;
exports.addItem = addItem;
exports.removeItem = removeItem;
exports.updateQuantity = updateQuantity;
exports.getCart = getCart;
exports.clearCart = clearCart;
exports.cartTotals = cartTotals;
const database_1 = require("../db/database");
const pricing_1 = require("./pricing");
function getOrCreateCart(psid) {
    let cart = database_1.db.prepare('SELECT id FROM carts WHERE psid = ?').get(psid);
    if (!cart) {
        database_1.db.prepare('INSERT INTO carts (psid) VALUES (?)').run(psid);
        cart = database_1.db.prepare('SELECT id FROM carts WHERE psid = ?').get(psid);
    }
    return cart.id;
}
function addItem(psid, item) {
    const cartId = getOrCreateCart(psid);
    database_1.db.prepare(`INSERT INTO cart_items (cart_id, product_id, package_id, variant_size, quantity, slot_choices)
    VALUES (?, ?, ?, ?, ?, ?)`).run(cartId, item.product_id ?? null, item.package_id ?? null, item.variant_size ?? null, item.quantity || 1, item.slot_choices ? JSON.stringify(item.slot_choices) : null);
    database_1.db.prepare("UPDATE carts SET updated_at = datetime('now') WHERE id = ?").run(cartId);
}
function removeItem(psid, itemId) {
    const cartId = getOrCreateCart(psid);
    database_1.db.prepare('DELETE FROM cart_items WHERE id = ? AND cart_id = ?').run(itemId, cartId);
}
function updateQuantity(psid, itemId, quantity) {
    const cartId = getOrCreateCart(psid);
    if (quantity <= 0)
        return removeItem(psid, itemId);
    database_1.db.prepare('UPDATE cart_items SET quantity = ? WHERE id = ? AND cart_id = ?').run(quantity, itemId, cartId);
}
function getCart(psid) {
    const cartId = getOrCreateCart(psid);
    const items = database_1.db.prepare(`
    SELECT ci.*, p.name AS product_name, pk.name AS package_name
    FROM cart_items ci
    LEFT JOIN products p ON p.id = ci.product_id
    LEFT JOIN packages pk ON pk.id = ci.package_id
    WHERE ci.cart_id = ?`).all(cartId);
    return items.map((it) => ({
        id: it.id,
        name: it.package_name ? `${it.package_name} (package)` : `${it.product_name} ${it.variant_size || ''}`.trim(),
        quantity: it.quantity,
        slot_choices: it.slot_choices ? (0, pricing_1.normalizeChoices)(JSON.parse(it.slot_choices)) : null,
        product_id: it.product_id,
        package_id: it.package_id,
        variant_size: it.variant_size,
    }));
}
function clearCart(psid) {
    const cartId = getOrCreateCart(psid);
    database_1.db.prepare('DELETE FROM cart_items WHERE cart_id = ?').run(cartId);
}
function cartTotals(psid, deliveryFee = 0) {
    const items = getCart(psid);
    return (0, pricing_1.computeCartTotals)(items, deliveryFee);
}
