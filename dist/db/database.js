"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = void 0;
exports.transaction = transaction;
exports.migrate = migrate;
const node_sqlite_1 = require("node:sqlite");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const DB_FILE = process.env.DATABASE_FILE || './data/postre.db';
fs_1.default.mkdirSync(path_1.default.dirname(DB_FILE), { recursive: true });
exports.db = new node_sqlite_1.DatabaseSync(DB_FILE);
exports.db.exec('PRAGMA journal_mode = WAL;');
exports.db.exec('PRAGMA foreign_keys = ON;');
/** Minimal stand-in for better-sqlite3's db.transaction(fn) - wraps fn in BEGIN/COMMIT. */
function transaction(fn) {
    return () => {
        exports.db.exec('BEGIN');
        try {
            const result = fn();
            exports.db.exec('COMMIT');
            return result;
        }
        catch (e) {
            exports.db.exec('ROLLBACK');
            throw e;
        }
    };
}
// Attach as a method so db.transaction(fn) works like better-sqlite3 callers expect.
exports.db.transaction = transaction;
function migrate() {
    exports.db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    psid TEXT UNIQUE NOT NULL,
    name TEXT,
    phone TEXT,
    address TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    name TEXT NOT NULL,
    description TEXT,
    photo_url TEXT,
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    unavailable INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS product_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    size TEXT NOT NULL,
    price INTEGER NOT NULL,
    UNIQUE(product_id, size)
  );

  CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    photo_url TEXT,
    base_price INTEGER NOT NULL,
    selections INTEGER NOT NULL,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS package_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
    slot_number INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS package_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slot_id INTEGER NOT NULL REFERENCES package_slots(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    upgrade_price INTEGER DEFAULT 0,
    size_upgrade_price INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS carts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    psid TEXT UNIQUE NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cart_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cart_id INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
    product_id INTEGER,
    package_id INTEGER,
    variant_size TEXT,
    quantity INTEGER NOT NULL DEFAULT 1,
    slot_choices TEXT
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT UNIQUE NOT NULL,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    order_type TEXT NOT NULL,
    address TEXT,
    delivery_fee INTEGER DEFAULT 0,
    subtotal INTEGER NOT NULL,
    total INTEGER NOT NULL,
    fulfillment_date TEXT,
    time_slot TEXT,
    payment_method TEXT,
    payment_status TEXT DEFAULT 'UNPAID',
    status TEXT DEFAULT 'PENDING',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER,
    package_id INTEGER,
    name TEXT NOT NULL,
    variant_size TEXT,
    quantity INTEGER NOT NULL,
    unit_price INTEGER NOT NULL,
    line_total INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS order_package_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    slot_number INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    upgrade_price INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS order_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    changed_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER REFERENCES orders(id),
    customer_name TEXT NOT NULL,
    phone TEXT,
    res_date TEXT NOT NULL,
    time_slot TEXT NOT NULL,
    status TEXT DEFAULT 'PENDING',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(res_date, time_slot, customer_name)
  );

  CREATE TABLE IF NOT EXISTS delivery_areas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    fee INTEGER NOT NULL,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS business_hours (
    day_of_week INTEGER PRIMARY KEY,
    open_time TEXT,
    close_time TEXT,
    closed INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS blocked_dates (
    date TEXT PRIMARY KEY,
    reason TEXT
  );

  CREATE TABLE IF NOT EXISTS time_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT UNIQUE NOT NULL,
    sort_order INTEGER DEFAULT 0,
    max_capacity INTEGER DEFAULT 5,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    method TEXT,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL,
    recorded_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversation_states (
    psid TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    context_json TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  `);
    const adminCount = exports.db.prepare('SELECT COUNT(*) c FROM admins').get().c;
    // v3: admin account management — role column (ADMIN | STAFF)
    const adminCols = exports.db.prepare('PRAGMA table_info(admins)').all().map((c) => c.name);
    if (!adminCols.includes('role')) {
        exports.db.exec(`ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'ADMIN';`);
    }
    // v4: package discounts — imported combos carry a `disc` amount that is
    // subtracted from base_price at checkout (never below zero).
    const pkgCols = exports.db.prepare('PRAGMA table_info(packages)').all().map((c) => c.name);
    if (!pkgCols.includes('discount')) {
        exports.db.exec(`ALTER TABLE packages ADD COLUMN discount INTEGER NOT NULL DEFAULT 0;`);
    }
    if (adminCount === 0) {
        const hash = bcryptjs_1.default.hashSync(process.env.ADMIN_PASSWORD || 'change-me', 10);
        exports.db.prepare('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)')
            .run(process.env.ADMIN_USER || 'admin', hash, 'ADMIN');
    }
    // Root admin stays in sync with the host's env vars. The seed above only runs
    // on a fresh DB — without this, changing ADMIN_PASSWORD/ADMIN_USER on the
    // host (e.g. Render env vars) would never take effect on an existing DB.
    // The env password always wins on boot; per-account changes made in the
    // Admins tab survive until the env password changes again.
    const envUser = (process.env.ADMIN_USER || 'admin').trim();
    const envPass = process.env.ADMIN_PASSWORD;
    if (envPass) {
        const root = exports.db.prepare('SELECT * FROM admins WHERE username = ?').get(envUser);
        if (root) {
            if (!bcryptjs_1.default.compareSync(envPass, root.password_hash)) {
                exports.db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?')
                    .run(bcryptjs_1.default.hashSync(envPass, 10), root.id);
                console.log(`[migrate] root admin "${envUser}" password synced from ADMIN_PASSWORD env`);
            }
        }
        else {
            exports.db.prepare('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)')
                .run(envUser, bcryptjs_1.default.hashSync(envPass, 10), 'ADMIN');
            console.log(`[migrate] root admin "${envUser}" created from ADMIN_USER/ADMIN_PASSWORD env`);
        }
    }
    const slotCount = exports.db.prepare('SELECT COUNT(*) c FROM time_slots').get().c;
    if (slotCount === 0) {
        const ins = exports.db.prepare('INSERT INTO time_slots (label, sort_order, max_capacity) VALUES (?, ?, ?)');
        ['10:00 AM', '12:00 PM', '2:00 PM', '4:00 PM', '6:00 PM'].forEach((l, i) => ins.run(l, i, 5));
    }
    const bhCount = exports.db.prepare('SELECT COUNT(*) c FROM business_hours').get().c;
    if (bhCount === 0) {
        const ins = exports.db.prepare('INSERT INTO business_hours (day_of_week, open_time, close_time, closed) VALUES (?, ?, ?, ?)');
        for (let d = 0; d < 7; d++)
            ins.run(d, '10:00', '19:00', d === 0 ? 1 : 0);
    }
    const catCount = exports.db.prepare('SELECT COUNT(*) c FROM categories').get().c;
    if (catCount === 0) {
        const ins = exports.db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)');
        ['Chicken', 'Pork', 'Beef', 'Noodles', 'Bilao', 'Desserts'].forEach((c, i) => ins.run(c, i));
    }
    // ---- v2: fixed / custom packages + default dish per slot ----
    const addCol = (table, col, ddl) => {
        const cols = exports.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        if (!cols.includes(col))
            exports.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} INTEGER ${ddl};`);
    };
    addCol('packages', 'is_fixed', 'DEFAULT 0');
    addCol('packages', 'is_custom', 'DEFAULT 0');
    addCol('package_options', 'is_default', 'DEFAULT 0');
    // v5 (one-time cleanup, kept for old DB copies): remove dead Supabase Storage
    // URLs from before the Supabase project was deleted. Harmless when no such
    // URLs remain — it only touches rows that literally contain "supabase.co".
    for (const [t, c] of [['products', 'photo_url'], ['packages', 'photo_url'], ['categories', 'image']]) {
        try {
            exports.db.exec(`UPDATE ${t} SET ${c} = NULL WHERE ${c} LIKE '%supabase.co%';`);
        }
        catch { /* column may not exist */ }
    }
    // Give every slot without a default its first option as the pre-selected dish.
    exports.db.exec(`UPDATE package_options SET is_default = 1 WHERE id IN (
    SELECT po.id FROM package_options po
    WHERE po.is_default = 0
      AND NOT EXISTS (SELECT 1 FROM package_options po3 WHERE po3.slot_id = po.slot_id AND po3.is_default = 1)
      AND po.id = (SELECT po2.id FROM package_options po2 WHERE po2.slot_id = po.slot_id ORDER BY po2.id LIMIT 1)
  );`);
    // Guarantee a "build your own" package exists so customers can create a custom package.
    const customCount = exports.db.prepare('SELECT COUNT(*) c FROM packages WHERE is_custom = 1 AND active = 1').get().c;
    if (customCount === 0) {
        const out = exports.db.prepare(`INSERT INTO packages (name, description, base_price, selections, is_custom)
      VALUES (?, ?, ?, ?, 1)`).run('Build Your Own Package', 'Create your own package - choose any 4 dishes', 1500, 4);
        const pkgId = Number(out.lastInsertRowid);
        const insSlot = exports.db.prepare('INSERT INTO package_slots (package_id, slot_number) VALUES (?, ?)');
        for (let i = 1; i <= 4; i++)
            insSlot.run(pkgId, i);
    }
    // Make sure there is at least one ready-to-order fixed package (fully filled slots, all menu dishes allowed).
    const fixedCount = exports.db.prepare('SELECT COUNT(*) c FROM packages WHERE is_fixed = 1 AND active = 1').get().c;
    if (fixedCount === 0) {
        const candidates = exports.db.prepare('SELECT * FROM packages WHERE active = 1 AND is_custom = 0 ORDER BY id').all();
        for (const p of candidates) {
            const slots = exports.db.prepare('SELECT * FROM package_slots WHERE package_id = ?').all(p.id);
            const complete = slots.length === p.selections && slots.every((s) => exports.db.prepare('SELECT COUNT(*) c FROM package_options WHERE slot_id = ?').get(s.id).c > 0);
            if (complete) {
                exports.db.prepare('UPDATE packages SET is_fixed = 1 WHERE id = ?').run(p.id);
                break;
            }
        }
    }
}
