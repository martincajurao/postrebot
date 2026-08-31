"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const database_1 = require("./database");
/**
 * One-time import: replaces the current menu (categories/products/variants) and
 * packages with the "Menu" and "Combo" collections from a backup JSON export
 * (mydb.json). Only attributes that exist in the current schema are used;
 * backup-only fields (branches, isHot, menuDisc, menuStatus, buyQty) are
 * intentionally ignored. The combo "disc" amount is imported as the package
 * discount and subtracted from base_price at checkout.
 *
 * Usage: node dist/db/import-backup.js [path/to/mydb.json]
 */
(0, database_1.migrate)();
const BACKUP_FILE = process.argv[2] || path_1.default.resolve(process.cwd(), 'mydb.json');
if (!fs_1.default.existsSync(BACKUP_FILE)) {
    console.error(`Backup file not found: ${BACKUP_FILE}`);
    process.exit(1);
}
const data = JSON.parse(fs_1.default.readFileSync(BACKUP_FILE, 'utf8'));
// Backup menuCategory codes -> current category names.
const CATEGORY_MAP = {
    CH: 'Chicken',
    PO: 'Pork',
    BF: 'Beef',
    PA: 'Noodles',
    SF: 'Seafood',
    VE: 'Vegetables',
    MC: 'Desserts',
};
const toInt = (v) => {
    if (v === undefined || v === null || v === '')
        return null;
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? n : null;
};
const cleanText = (v) => {
    const s = (v ?? '').toString().trim();
    return s === '' ? null : s;
};
const menu = data.Menu || {};
const combos = data.Combo || {};
const catOf = (m) => {
    const key = (m.menuCategory || '').toString().trim().toUpperCase();
    if (key)
        return CATEGORY_MAP[key] || 'Others';
    // A few items (e.g. Pork Humba) carry no category — infer from the name.
    const n = (m.menuName || '').toLowerCase();
    if (n.startsWith('pork'))
        return CATEGORY_MAP.PO;
    if (n.startsWith('chicken'))
        return CATEGORY_MAP.CH;
    if (n.startsWith('beef'))
        return CATEGORY_MAP.BF;
    return 'Others';
};
const byCat = new Map();
for (const m of Object.values(menu)) {
    const cat = catOf(m);
    if (!byCat.has(cat))
        byCat.set(cat, []);
    byCat.get(cat).push(m);
}
const PREFERRED_ORDER = ['Chicken', 'Pork', 'Beef', 'Seafood', 'Noodles', 'Vegetables', 'Desserts', 'Others'];
const usedCats = [...byCat.keys()].sort((a, b) => {
    const ia = PREFERRED_ORDER.indexOf(a);
    const ib = PREFERRED_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
});
// ---- import transaction ----
const tx = database_1.db.transaction(() => {
    // Wipe current menu + packages (children first). Carts are cleared
    // because their rows reference product/package ids that no longer exist.
    database_1.db.exec(`
    DELETE FROM package_options;
    DELETE FROM package_slots;
    DELETE FROM packages;
    DELETE FROM product_variants;
    DELETE FROM products;
    DELETE FROM categories;
    DELETE FROM cart_items;
    DELETE FROM carts;
  `);
    // Categories
    const insCat = database_1.db.prepare('INSERT INTO categories (name, sort_order, active) VALUES (?, ?, 1)');
    const catId = {};
    usedCats.forEach((name, i) => {
        catId[name] = Number(insCat.run(name, i).lastInsertRowid);
    });
    // Menu -> products + M/L variants
    const insProduct = database_1.db.prepare('INSERT INTO products (category_id, name, description, photo_url, sort_order, active, unavailable) VALUES (?, ?, ?, ?, ?, 1, 0)');
    const insVariant = database_1.db.prepare('INSERT INTO product_variants (product_id, size, price) VALUES (?, ?, ?)');
    const productByCode = {};
    let sort = 0;
    for (const catName of usedCats) {
        const list = byCat.get(catName).sort((a, b) => (a.menuName || '').localeCompare(b.menuName || ''));
        for (const m of list) {
            const out = insProduct.run(catId[catName], m.menuName, cleanText(m.menuDesc), cleanText(m.img), sort++);
            const pid = Number(out.lastInsertRowid);
            if (m.menuCode)
                productByCode[m.menuCode] = pid;
            const medium = toInt(m.menuPrices?.medium ?? m.menuPrice);
            const large = toInt(m.menuPrices?.large);
            if (medium != null)
                insVariant.run(pid, 'M', medium);
            if (large != null)
                insVariant.run(pid, 'L', large);
        }
    }
    // Combos -> fixed packages (one dish per slot; backup has no upgrade data)
    const insPkg = database_1.db.prepare('INSERT INTO packages (name, description, photo_url, base_price, discount, selections, active, is_fixed, is_custom) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 0)');
    const insSlot = database_1.db.prepare('INSERT INTO package_slots (package_id, slot_number) VALUES (?, ?)');
    const insOpt = database_1.db.prepare('INSERT INTO package_options (slot_id, product_id, upgrade_price, size_upgrade_price, is_default) VALUES (?, ?, 0, 0, 1)');
    const missing = [];
    for (const [code, c] of Object.entries(combos)) {
        const members = Array.isArray(c.members) ? c.members : Object.values(c.members || {});
        const out = insPkg.run(code, cleanText(c.desc), cleanText(c.img), toInt(c.price), toInt(c.disc) ?? 0, members.length);
        const pkgId = Number(out.lastInsertRowid);
        let slotNo = 1;
        for (const mem of members) {
            const pid = mem?.menuCode ? productByCode[mem.menuCode] : undefined;
            if (!pid) {
                missing.push(`${code}: ${mem?.menuName || mem?.menuCode || '?'}`);
                continue;
            }
            const slot = insSlot.run(pkgId, slotNo++);
            insOpt.run(Number(slot.lastInsertRowid), pid);
        }
    }
    if (missing.length) {
        throw new Error(`Unresolved combo members (import aborted): ${missing.join(', ')}`);
    }
    return { products: Object.keys(productByCode).length, packages: Object.keys(combos).length };
});
try {
    const stats = tx();
    const count = (t) => database_1.db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    console.log('Import complete.', JSON.stringify(stats));
    console.log(`categories=${count('categories')} products=${count('products')} variants=${count('product_variants')} ` +
        `packages=${count('packages')} slots=${count('package_slots')} options=${count('package_options')}`);
    for (const p of database_1.db.prepare('SELECT id, name, base_price, discount, selections FROM packages ORDER BY id').all()) {
        const slots = database_1.db.prepare('SELECT COUNT(*) c FROM package_slots WHERE package_id = ?').get(p.id).c;
        const net = Math.max(0, p.base_price - (p.discount || 0));
        console.log(`  package ${p.name}: ₱${net}${p.discount ? ` (was ₱${p.base_price}, save ₱${p.discount})` : ''}, ${p.selections} selections, ${slots} slots`);
    }
}
catch (e) {
    console.error('Import failed (rolled back):', e.message);
    process.exit(1);
}
