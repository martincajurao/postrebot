"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleMessage = handleMessage;
const express_1 = require("express");
const database_1 = require("../db/database");
const send_1 = require("./send");
const cart_1 = require("../services/cart");
const orders_1 = require("../services/orders");
const reservations_1 = require("../services/reservations");
const pricing_1 = require("../services/pricing");
const r = (0, express_1.Router)();
const BASE_URL = process.env.BASE_URL || '';
/** Messenger requires absolute https URLs for images. */
function absUrl(url) {
    if (!url)
        return undefined;
    if (/^https?:\/\//.test(url))
        return url;
    if (!BASE_URL)
        return undefined; // no public URL configured -> skip image
    return BASE_URL.replace(/\/$/, '') + url;
}
// ---------- helpers ----------
function ensureCustomer(psid) {
    let c = database_1.db.prepare('SELECT * FROM customers WHERE psid = ?').get(psid);
    if (!c) {
        database_1.db.prepare('INSERT INTO customers (psid) VALUES (?)').run(psid);
        c = database_1.db.prepare('SELECT * FROM customers WHERE psid = ?').get(psid);
    }
    return c;
}
function mainMenu(psid) {
    (0, send_1.setState)(psid, 'MAIN_MENU');
    (0, send_1.sendButtons)(psid, 'Welcome to Postre Food Products!\n\nHow can we help you today?', [
        { title: 'Order Now', payload: 'MENU_ORDER' },
        { title: 'Packages', payload: 'MENU_PACKAGES' },
        { title: 'Menu', payload: 'MENU_BROWSE' },
    ]).then(() => (0, send_1.sendQuickReplies)(psid, 'More options:', [
        { title: 'Reservation', payload: 'MENU_RESERVE' },
        { title: 'My Cart', payload: 'MENU_CART' },
        { title: 'Contact Us', payload: 'MENU_CONTACT' },
    ]));
}
function money(n) { return `\u20b1${n.toLocaleString('en-PH')}`; }
async function showCart(psid) {
    const items = (0, cart_1.getCart)(psid);
    if (items.length === 0) {
        await (0, send_1.sendText)(psid, 'Your cart is empty.');
        return mainMenu(psid);
    }
    const totals = (0, cart_1.cartTotals)(psid);
    const lines = items.map((i) => {
        let label = `${i.quantity}x ${i.name}`;
        if (i.package_id && Array.isArray(i.slot_choices) && i.slot_choices.length) {
            const dishes = i.slot_choices
                .map((c) => database_1.db.prepare('SELECT name FROM products WHERE id = ?').get(c.product_id)?.name)
                .filter(Boolean).join(', ');
            if (dishes)
                label += `\n(${dishes})`;
        }
        let lineTotal = 0;
        try {
            lineTotal = (0, pricing_1.computeCartTotals)([i], 0).subtotal;
        }
        catch {
            lineTotal = 0;
        }
        return `${label} — ${money(lineTotal)}`;
    }).join('\n');
    await (0, send_1.sendText)(psid, `YOUR CART\n\n${lines}\n\nTotal: ${money(totals.total)}`);
    return (0, send_1.sendButtons)(psid, 'What would you like to do?', [
        { title: 'Checkout', payload: 'CART_CHECKOUT' },
        { title: 'Add More', payload: 'MENU_ORDER' },
        { title: 'Remove Item', payload: 'CART_REMOVE' },
    ]);
}
function showCategories(psid, backPayload = 'MAIN_MENU_BACK') {
    const cats = database_1.db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY sort_order').all();
    (0, send_1.setState)(psid, 'ORDER_CATEGORY', { back: backPayload });
    (0, send_1.sendQuickReplies)(psid, 'Choose a category:', [
        ...cats.map((c) => ({ title: c.name, payload: `CAT:${c.id}` })),
        { title: 'Back', payload: backPayload },
    ]);
}
function showProducts(psid, categoryId) {
    const products = database_1.db.prepare('SELECT * FROM products WHERE category_id = ? AND active = 1 AND unavailable = 0 ORDER BY sort_order').all(categoryId);
    if (products.length === 0) {
        return (0, send_1.sendText)(psid, 'No products in this category yet.').then(() => showCategories(psid));
    }
    (0, send_1.setState)(psid, 'ORDER_PRODUCT', { category_id: categoryId });
    (0, send_1.sendCarousel)(psid, products.map((p) => {
        const variants = database_1.db.prepare('SELECT * FROM product_variants WHERE product_id = ?').all(p.id);
        const subtitle = variants.map((v) => `${v.size} ${money(v.price)}`).join(' - ');
        return {
            title: p.name,
            subtitle: `${p.description || ''}\n${subtitle}`.trim(),
            image_url: absUrl(p.photo_url),
            buttons: [{ title: 'Order', payload: `PROD:${p.id}` }],
        };
    })).then(() => (0, send_1.sendQuickReplies)(psid, 'Or pick from the list:', [
        ...products.slice(0, 10).map((p) => ({ title: p.name.slice(0, 20), payload: `PROD:${p.id}` })),
        { title: 'Categories', payload: 'MENU_ORDER' },
    ]));
}
async function showVariants(psid, productId) {
    const product = database_1.db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product)
        return (0, send_1.sendText)(psid, 'Product not found.');
    const variants = database_1.db.prepare('SELECT * FROM product_variants WHERE product_id = ?').all(productId);
    (0, send_1.setState)(psid, 'ORDER_VARIANT', { product_id: productId });
    if (variants.length === 1) {
        return handlePayload(psid, `SIZE:${productId}:${variants[0].size}`);
    }
    (0, send_1.sendQuickReplies)(psid, `Select a size for ${product.name}:`, [
        ...variants.map((v) => ({ title: `${v.size} ${money(v.price)}`.slice(0, 20), payload: `SIZE:${productId}:${v.size}` })),
        { title: 'Back', payload: `CAT:${product.category_id}` },
    ]);
}
function showQuantity(psid, productId, size) {
    (0, send_1.setState)(psid, 'ORDER_QUANTITY', { product_id: productId, size });
    const v = database_1.db.prepare('SELECT * FROM product_variants WHERE product_id = ? AND size = ?').get(productId, size);
    (0, send_1.sendQuickReplies)(psid, `How many (${size} - ${money(v.price)})?`, [
        { title: '1', payload: `QTY:${productId}:${size}:1` },
        { title: '2', payload: `QTY:${productId}:${size}:2` },
        { title: '3', payload: `QTY:${productId}:${size}:3` },
        { title: '5', payload: `QTY:${productId}:${size}:5` },
    ]);
}
// ---------- packages ----------
function getPackage(packageId) {
    return database_1.db.prepare('SELECT * FROM packages WHERE id = ? AND active = 1').get(packageId);
}
function showPackages(psid) {
    const packages = database_1.db.prepare('SELECT * FROM packages WHERE active = 1 ORDER BY is_custom, id').all();
    (0, send_1.setState)(psid, 'PACKAGE_LIST');
    if (packages.length === 0)
        return (0, send_1.sendText)(psid, 'No packages available right now.');
    const elements = packages.map((p) => p.is_custom ? {
        title: p.name,
        subtitle: `${money(p.base_price)} base — Pick any ${p.selections} dishes you like`,
        image_url: absUrl(p.photo_url),
        buttons: [{ title: 'Start Building', payload: `PKG:${p.id}` }],
    } : {
        title: p.name,
        subtitle: `${money((0, pricing_1.netPackagePrice)(p))}${p.discount > 0 ? ` — Save ${money(p.discount)}` : ''} — ${p.is_fixed ? `Fixed: ${p.selections} dishes, ready to order` : `Choose ${p.selections} dishes`}`,
        image_url: absUrl(p.photo_url),
        buttons: [{ title: 'View Package', payload: `PKG:${p.id}` }],
    });
    return (0, send_1.sendCarousel)(psid, elements);
}
function packageLines(packageId, choices) {
    const slots = database_1.db.prepare('SELECT * FROM package_slots WHERE package_id = ? ORDER BY slot_number').all(packageId);
    return slots.map((s) => {
        const pid = choices?.[s.slot_number];
        const prod = pid ? database_1.db.prepare('SELECT name FROM products WHERE id = ?').get(pid) : null;
        return `${s.slot_number}. ${prod ? prod.name : '(not chosen yet)'}`;
    }).join('\n');
}
/** Authoritative total for a complete set of choices, or null when incomplete/invalid. */
function packageTotal(packageId, choices, size) {
    const pkg = getPackage(packageId);
    if (!pkg)
        return null;
    const arr = Object.entries(choices || {}).map(([k, v]) => ({ slot_number: Number(k), product_id: Number(v) }));
    if (arr.length !== pkg.selections)
        return null;
    try {
        return (0, pricing_1.pricePackage)(packageId, arr, size).total;
    }
    catch {
        return null;
    }
}
function showPackageDetails(psid, packageId, ctx) {
    const pkg = getPackage(packageId);
    if (!pkg)
        return (0, send_1.sendText)(psid, 'Package not found.');
    const prev = ctx || (0, send_1.getState)(psid).ctx;
    const saved = {};
    if (prev && prev.package_id === packageId && prev.choices) {
        for (const [k, v] of Object.entries(prev.choices))
            saved[Number(k)] = Number(v);
    }
    const defaults = {};
    for (const d of (0, pricing_1.packageDefaults)(packageId))
        defaults[d.slot_number] = d.product_id;
    const choices = pkg.is_custom ? { ...saved } : { ...defaults, ...saved };
    (0, send_1.setState)(psid, 'PACKAGE_DETAILS', { package_id: packageId, choices });
    if (pkg.is_fixed) {
        const mTotal = packageTotal(packageId, choices, 'M') ?? (0, pricing_1.netPackagePrice)(pkg);
        const lTotal = packageTotal(packageId, choices, 'L') ?? (0, pricing_1.netPackagePrice)(pkg);
        const saveNote = pkg.discount > 0 ? ` (was ${money(pkg.base_price)} — Save ${money(pkg.discount)})` : '';
        return (0, send_1.sendText)(psid, `${pkg.name}\n${money(mTotal)}${saveNote}\n\n${packageLines(packageId, choices)}`)
            .then(() => (0, send_1.sendQuickReplies)(psid, 'This package is ready to order:', [
            { title: `Add M ${money(mTotal)}`.slice(0, 20), payload: `PKGADD:${packageId}:M:1` },
            { title: `Add L ${money(lTotal)}`.slice(0, 20), payload: `PKGADD:${packageId}:L:1` },
            { title: 'Packages', payload: 'MENU_PACKAGES' },
        ]));
    }
    const slots = database_1.db.prepare('SELECT * FROM package_slots WHERE package_id = ? ORDER BY slot_number').all(packageId);
    const filled = Object.keys(choices).length;
    const header = pkg.is_custom
        ? `${pkg.name}\n${money(pkg.base_price)} base\n\nPick any ${pkg.selections} dishes (${filled}/${pkg.selections} chosen):\n\n${packageLines(packageId, choices)}`
        : `${pkg.name}\n${money((0, pricing_1.netPackagePrice)(pkg))}${pkg.discount > 0 ? ` — Save ${money(pkg.discount)}` : ''}\n\n${packageLines(packageId, choices)}`;
    const verb = pkg.is_custom ? 'Pick' : 'Change';
    const replies = slots.slice(0, 11).map((s) => ({
        title: `${verb} #${s.slot_number}`.slice(0, 20),
        payload: `SLOT:${packageId}:${s.slot_number}`,
    }));
    if (!pkg.is_custom || filled >= pkg.selections) {
        replies.push({ title: 'Size & Add', payload: `PKGSIZE:${packageId}` });
    }
    return (0, send_1.sendText)(psid, header)
        .then(() => (0, send_1.sendQuickReplies)(psid, pkg.is_custom ? 'Build your package:' : 'Customize your package:', replies));
}
function showSlotOptions(psid, packageId, slotNumber, page = 0) {
    const st = (0, send_1.getState)(psid);
    const pkg = getPackage(packageId);
    if (!pkg)
        return (0, send_1.sendText)(psid, 'Package not found.');
    const slot = database_1.db.prepare('SELECT * FROM package_slots WHERE package_id = ? AND slot_number = ?').get(packageId, slotNumber);
    if (!slot)
        return (0, send_1.sendText)(psid, 'Invalid slot.');
    let opts;
    if (pkg.is_custom) {
        // Custom package: every active menu dish is allowed (admin-defined upgrade prices still apply).
        opts = database_1.db.prepare(`SELECT id AS product_id, name AS product_name, 0 AS upgrade_price
      FROM products WHERE active = 1 AND unavailable = 0 ORDER BY name`).all();
        const ups = database_1.db.prepare(`SELECT po.product_id, po.upgrade_price FROM package_options po
      JOIN package_slots ps ON ps.id = po.slot_id WHERE ps.package_id = ?`).all(packageId);
        for (const u of ups) {
            const o = opts.find((x) => x.product_id === u.product_id);
            if (o)
                o.upgrade_price = u.upgrade_price || 0;
        }
    }
    else {
        opts = database_1.db.prepare(`SELECT po.product_id, po.upgrade_price, p.name AS product_name
      FROM package_options po JOIN products p ON p.id = po.product_id
      WHERE po.slot_id = ? AND p.active = 1 AND p.unavailable = 0 ORDER BY p.name`).all(slot.id);
    }
    if (opts.length === 0)
        return (0, send_1.sendText)(psid, 'No dishes available for this slot right now.');
    const PAGE = 10;
    const pages = Math.ceil(opts.length / PAGE);
    const safePage = Math.max(0, Math.min(page, pages - 1));
    const ctx = st.ctx.package_id === packageId ? st.ctx : { package_id: packageId, choices: {} };
    (0, send_1.setState)(psid, 'SELECT_OPTION', { ...ctx, slot_number: slotNumber });
    const replies = opts.slice(safePage * PAGE, safePage * PAGE + PAGE).map((o) => ({
        title: `${o.product_name}${o.upgrade_price > 0 ? ` +${money(o.upgrade_price)}` : ''}`.slice(0, 20),
        payload: `CHOICE:${packageId}:${slotNumber}:${o.product_id}`,
    }));
    if (safePage + 1 < pages)
        replies.push({ title: 'More options...', payload: `SLOTPG:${packageId}:${slotNumber}:${safePage + 1}` });
    if (safePage > 0)
        replies.push({ title: 'Previous page', payload: `SLOTPG:${packageId}:${slotNumber}:${safePage - 1}` });
    return (0, send_1.sendQuickReplies)(psid, `Choose dish for slot #${slotNumber}:`, replies);
}
function afterChoice(psid, packageId, slotNumber, productId) {
    const st = (0, send_1.getState)(psid);
    const base = st.ctx && st.ctx.package_id === packageId ? st.ctx : { package_id: packageId, choices: {} };
    const ctx = { ...base, choices: { ...(base.choices || {}), [slotNumber]: productId } };
    return showPackageDetails(psid, packageId, ctx);
}
function showPackageSize(psid, packageId, ctx) {
    const c = ctx || (0, send_1.getState)(psid).ctx;
    const choices = {};
    if (c && c.choices)
        for (const [k, v] of Object.entries(c.choices))
            choices[Number(k)] = Number(v);
    (0, send_1.setState)(psid, 'PACKAGE_SIZE', { package_id: packageId, choices });
    const pkg = getPackage(packageId);
    const m = packageTotal(packageId, choices, 'M');
    const l = packageTotal(packageId, choices, 'L');
    const priceLine = m != null ? `\n\nTotal M: ${money(m)} | Total L: ${money(l ?? (pkg ? (0, pricing_1.netPackagePrice)(pkg) : 0))}` : '';
    return (0, send_1.sendQuickReplies)(psid, `Package dish size? (L may add an upgrade fee)${priceLine}`, [
        { title: 'M - Included', payload: `PKGADD:${packageId}:M:1` },
        { title: 'L + Upgrade', payload: `PKGADD:${packageId}:L:1` },
        { title: 'Back to Menu', payload: 'MAIN_MENU_BACK' },
    ]);
}
function checkoutStart(psid) {
    const items = (0, cart_1.getCart)(psid);
    if (items.length === 0)
        return (0, send_1.sendText)(psid, 'Your cart is empty.');
    (0, send_1.setState)(psid, 'CHECKOUT_TYPE');
    (0, send_1.sendQuickReplies)(psid, 'Delivery or Pickup?', [
        { title: 'Delivery', payload: 'TYPE:delivery' },
        { title: 'Pickup', payload: 'TYPE:pickup' },
    ]);
}
function addPackageToCart(psid, packageId, size, qty) {
    const pkg = getPackage(packageId);
    if (!pkg)
        return (0, send_1.sendText)(psid, 'Package not found.');
    const chosenSize = size.toUpperCase() === 'L' ? 'L' : 'M';
    const st = (0, send_1.getState)(psid).ctx;
    const choices = {};
    if (st && st.package_id === packageId && st.choices) {
        for (const [k, v] of Object.entries(st.choices))
            choices[Number(k)] = Number(v);
    }
    if (Object.keys(choices).length === 0) {
        for (const d of (0, pricing_1.packageDefaults)(packageId))
            choices[d.slot_number] = d.product_id;
    }
    if (Object.keys(choices).length !== pkg.selections) {
        return showPackageDetails(psid, packageId, { package_id: packageId, choices });
    }
    const arr = Object.entries(choices).map(([k, v]) => ({ slot_number: Number(k), product_id: Number(v) }));
    let total = (0, pricing_1.netPackagePrice)(pkg);
    try {
        total = (0, pricing_1.pricePackage)(packageId, arr, chosenSize).total;
    }
    catch { /* fall back to base price */ }
    (0, cart_1.addItem)(psid, { package_id: packageId, variant_size: chosenSize, quantity: qty, slot_choices: arr });
    return (0, send_1.sendText)(psid, `Added ${qty}x ${pkg.name} (${chosenSize}) to your cart.\n\n${packageLines(packageId, choices)}\nPrice: ${money(total)}`)
        .then(() => (0, send_1.sendButtons)(psid, 'What next?', [
        { title: 'View Cart', payload: 'MENU_CART' },
        { title: 'Checkout', payload: 'CART_CHECKOUT' },
        { title: 'Keep Shopping', payload: 'MENU_ORDER' },
    ]));
}
async function handlePayload(psid, payload) {
    const [cmd, ...rest] = payload.split(':');
    switch (cmd) {
        case 'GET_STARTED':
        case 'MAIN_MENU':
        case 'MAIN_MENU_BACK':
            return mainMenu(psid);
        case 'MENU_ORDER':
            return showCategories(psid);
        case 'MENU_PACKAGES':
            return showPackages(psid);
        case 'MENU_BROWSE': {
            const cats = database_1.db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY sort_order').all();
            (0, send_1.setState)(psid, 'BROWSE_CATEGORY');
            return (0, send_1.sendQuickReplies)(psid, 'Browse our menu:', [
                ...cats.map((c) => ({ title: c.name, payload: `BROWSE:${c.id}` })),
                { title: 'Back', payload: 'MAIN_MENU_BACK' },
            ]);
        }
        case 'BROWSE':
            return showProducts(psid, Number(rest[0]));
        case 'CAT':
            return showProducts(psid, Number(rest[0]));
        case 'PROD':
            return showVariants(psid, Number(rest[0]));
        case 'SIZE': {
            const productId = Number(rest[0]);
            const size = rest[1];
            return showQuantity(psid, productId, size);
        }
        case 'QTY': {
            const productId = Number(rest[0]);
            const size = rest[1];
            const qty = Number(rest[2]);
            const product = database_1.db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
            const v = database_1.db.prepare('SELECT * FROM product_variants WHERE product_id = ? AND size = ?').get(productId, size);
            (0, cart_1.addItem)(psid, { product_id: productId, variant_size: size, quantity: qty });
            (0, send_1.sendText)(psid, `Added ${qty}x ${product.name} (${size}) to your cart.`)
                .then(() => (0, send_1.sendButtons)(psid, 'What next?', [
                { title: 'View Cart', payload: 'MENU_CART' },
                { title: 'Checkout', payload: 'CART_CHECKOUT' },
                { title: 'Keep Shopping', payload: 'MENU_ORDER' },
            ]));
            return;
        }
        case 'MENU_CART':
            return showCart(psid);
        case 'CART_REMOVE': {
            const items = (0, cart_1.getCart)(psid);
            if (items.length === 0)
                return (0, send_1.sendText)(psid, 'Your cart is empty.');
            (0, send_1.setState)(psid, 'CART_REMOVE_ITEM');
            return (0, send_1.sendQuickReplies)(psid, 'Remove which item?', [
                ...items.slice(0, 10).map((i) => ({ title: `${i.name} (${i.size})`.slice(0, 20), payload: `REMOVE:${i.line_id}` })),
                { title: 'Cancel', payload: 'MENU_CART' },
            ]);
        }
        case 'REMOVE': {
            const lineId = Number(rest[0]);
            (0, cart_1.removeItem)(psid, lineId);
            return showCart(psid);
        }
        case 'CART_CHECKOUT':
            return checkoutStart(psid);
        case 'TYPE': {
            const type = rest[0];
            (0, send_1.setState)(psid, 'CHECKOUT_ADDRESS', { delivery_type: type });
            if (type === 'pickup')
                return handlePayload(psid, 'ASK_PHONE');
            return (0, send_1.sendText)(psid, 'Please type your delivery address (house #, street, barangay, city):');
        }
        case 'ASK_PHONE':
            (0, send_1.setState)(psid, 'CHECKOUT_PHONE', (0, send_1.getState)(psid).ctx);
            return (0, send_1.sendText)(psid, 'Please type your contact number:');
        case 'ASK_NOTES':
            (0, send_1.setState)(psid, 'CHECKOUT_NOTES', (0, send_1.getState)(psid).ctx);
            return (0, send_1.sendText)(psid, 'Any special notes? (type "none" to skip)');
        case 'ASK_PAY':
            (0, send_1.setState)(psid, 'CHECKOUT_PAY', (0, send_1.getState)(psid).ctx);
            return (0, send_1.sendQuickReplies)(psid, 'Payment method:', [
                { title: 'COD', payload: 'PAY:cod' },
                { title: 'GCash', payload: 'PAY:gcash' },
                { title: 'Bank Transfer', payload: 'PAY:bank' },
            ]);
        case 'PAY': {
            const method = rest[0];
            const st = (0, send_1.getState)(psid);
            try {
                const cust = database_1.db.prepare('SELECT id FROM customers WHERE psid = ?').get(psid);
                if (!cust)
                    throw new Error('Customer not found');
                // Remember contact details collected during checkout on the customer record.
                if (st.ctx.phone || st.ctx.address) {
                    database_1.db.prepare('UPDATE customers SET phone = COALESCE(?, phone), address = COALESCE(?, address) WHERE id = ?')
                        .run(st.ctx.phone ?? null, st.ctx.address ?? null, cust.id);
                }
                const order = (0, orders_1.createOrderFromCart)(psid, { customer_id: cust.id, order_type: st.ctx.delivery_type || 'delivery', address: st.ctx.address, notes: st.ctx.notes, payment_method: method });
                (0, send_1.setState)(psid, 'ORDER_CONFIRMED', { order_id: order.orderId });
                const payInfo = {
                    cod: 'Pay in cash when your order arrives.',
                    gcash: 'GCash: 0917-000-0000 (Postre Foods). Send the receipt to confirm.',
                    bank: 'BDO: 1234-5678-9012 (Postre Foods). Send the receipt to confirm.',
                }[method] || '';
                (0, send_1.sendText)(psid, `Order #${order.orderNumber} confirmed!\nTotal: ${money(order.total)}\n\n${payInfo}`)
                    .then(() => mainMenu(psid));
            }
            catch (e) {
                (0, send_1.sendText)(psid, 'Sorry, something went wrong placing your order. Please try again.').then(() => mainMenu(psid));
            }
            return;
        }
        case 'PKG':
            return showPackageDetails(psid, Number(rest[0]));
        case 'SLOT':
            return showSlotOptions(psid, Number(rest[0]), Number(rest[1]));
        case 'SLOTPG':
            return showSlotOptions(psid, Number(rest[0]), Number(rest[1]), Number(rest[2] || 0));
        case 'CHOICE':
            return afterChoice(psid, Number(rest[0]), Number(rest[1]), Number(rest[2]));
        case 'PKGSIZE':
            return showPackageSize(psid, Number(rest[0]));
        case 'PKGADD':
            return addPackageToCart(psid, Number(rest[0]), rest[1], Number(rest[2]));
        case 'MENU_RESERVE':
            (0, send_1.setState)(psid, 'RESERVE_TYPE');
            return (0, send_1.sendQuickReplies)(psid, 'Reservation for?', [
                { title: 'Cottage', payload: 'RESTYPE:Cottage' },
                { title: 'Table', payload: 'RESTYPE:Table' },
            ]);
        case 'RESTYPE': {
            const type = rest[0];
            (0, send_1.setState)(psid, 'RESERVE_DATE', { res_type: type });
            return (0, send_1.sendText)(psid, 'What date? (format: YYYY-MM-DD)');
        }
        case 'MENU_CONTACT':
            (0, send_1.setState)(psid, 'CONTACT_MENU');
            return (0, send_1.sendText)(psid, 'Contact us:\nPhone: 0917-000-0000\nEmail: hello@postre.example\nAddress: 123 Sample St.')
                .then(() => mainMenu(psid));
        default:
            return mainMenu(psid);
    }
}
async function handleText(psid, text) {
    const st = (0, send_1.getState)(psid);
    const state = st.state;
    const ctx = st.ctx || {};
    switch (state) {
        case 'CHECKOUT_ADDRESS':
            (0, send_1.setState)(psid, 'CHECKOUT_ADDRESS_DONE', { ...ctx, address: text });
            return handlePayload(psid, 'ASK_PHONE');
        case 'CHECKOUT_PHONE':
            if (!/^[0-9+\-\s()]{7,15}$/.test(text.trim())) {
                return (0, send_1.sendText)(psid, 'That does not look like a valid phone number. Please try again:');
            }
            (0, send_1.setState)(psid, 'CHECKOUT_PHONE_DONE', { ...ctx, phone: text.trim() });
            return handlePayload(psid, 'ASK_NOTES');
        case 'CHECKOUT_NOTES':
            (0, send_1.setState)(psid, 'CHECKOUT_NOTES_DONE', { ...ctx, notes: text.trim().toLowerCase() === 'none' ? '' : text.trim() });
            return handlePayload(psid, 'ASK_PAY');
        case 'RESERVE_DATE': {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(text.trim())) {
                return (0, send_1.sendText)(psid, 'Please use the date format YYYY-MM-DD, e.g. 2025-06-15:');
            }
            if (!(0, reservations_1.isDateOpen)(text.trim())) {
                return (0, send_1.sendText)(psid, 'We are closed on that day. Please pick another date (YYYY-MM-DD):');
            }
            (0, send_1.setState)(psid, 'RESERVE_TIME', { ...ctx, res_date: text.trim() });
            return (0, send_1.sendText)(psid, 'What time? (format: HH:MM, 24-hour, e.g. 15:30)');
        }
        case 'RESERVE_TIME': {
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text.trim())) {
                return (0, send_1.sendText)(psid, 'Please use the time format HH:MM, e.g. 15:30:');
            }
            const slots = (0, reservations_1.slotAvailability)(ctx.res_date);
            (0, send_1.setState)(psid, 'RESERVE_SLOT', { ...ctx, res_time: text.trim() });
            return (0, send_1.sendQuickReplies)(psid, 'Choose a slot:', [
                ...slots.filter((s) => !s.full).map((s) => ({ title: `${s.label} (${s.capacity - s.used} left)`.slice(0, 20), payload: `RESSLOT:${s.label}` })),
            ]);
        }
        case 'RESERVE_NAME':
            (0, send_1.setState)(psid, 'RESERVE_NAME_DONE', { ...ctx, res_name: text.trim() });
            return handlePayload(psid, 'RES_PHONE_ASK');
        default:
            // unknown text -> main menu
            if (text.toLowerCase().includes('menu') || text.toLowerCase().startsWith('hi'))
                return mainMenu(psid);
            return (0, send_1.sendText)(psid, 'Sorry, I did not understand that.').then(() => mainMenu(psid));
    }
}
function handleMessage(messaging) {
    const psid = messaging.sender?.id;
    if (!psid)
        return;
    ensureCustomer(psid);
    if (messaging.postback?.payload) {
        const payload = messaging.postback.payload;
        if (payload.startsWith('RESSLOT:')) {
            const timeSlot = payload.slice('RESSLOT:'.length);
            const st = (0, send_1.getState)(psid);
            (0, send_1.setState)(psid, 'RESERVE_NAME', { ...st.ctx, res_time: timeSlot });
            (0, send_1.sendText)(psid, 'Name for the reservation?');
            return;
        }
        if (payload === 'RES_PHONE_ASK') {
            (0, send_1.setState)(psid, 'RESERVE_PHONE', (0, send_1.getState)(psid).ctx);
            (0, send_1.sendText)(psid, 'Contact number for the reservation?');
            return;
        }
        if (payload.startsWith('RES_PHONE:')) {
            const phone = payload.split(':')[1];
            const st = (0, send_1.getState)(psid);
            try {
                const res = (0, reservations_1.createReservation)({ customer_name: st.ctx.res_name, phone, res_date: st.ctx.res_date, time_slot: st.ctx.res_time, notes: st.ctx.res_type });
                (0, send_1.setState)(psid, 'RESERVE_CONFIRMED', { res_id: res });
                (0, send_1.sendText)(psid, `Reservation confirmed! Reference: RES-${res}\n${st.ctx.res_type} on ${st.ctx.res_date} at ${st.ctx.res_time}.`)
                    .then(() => mainMenu(psid));
            }
            catch (e) {
                (0, send_1.sendText)(psid, 'Could not complete the reservation. Please try again.').then(() => mainMenu(psid));
            }
            return;
        }
        return void handlePayload(psid, payload);
    }
    if (messaging.message?.quick_reply?.payload) {
        return void handlePayload(psid, messaging.message.quick_reply.payload);
    }
    if (messaging.message?.text) {
        return void handleText(psid, messaging.message.text);
    }
}
// ---------- Meta webhook verification (GET) ----------
r.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
        console.log('[webhook] verified');
        return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
});
// ---------- Meta webhook events (POST) ----------
r.post('/', (req, res) => {
    const body = req.body;
    if (body?.object === 'page') {
        for (const entry of body.entry || []) {
            for (const messaging of entry.messaging || []) {
                try {
                    handleMessage(messaging);
                }
                catch (e) {
                    console.error('[webhook] handler error', e);
                }
            }
        }
        return res.status(200).send('EVENT_RECEIVED');
    }
    return res.sendStatus(404);
});
exports.default = r;
