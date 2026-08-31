import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcryptjs';

const DB_FILE = process.env.DATABASE_FILE || './data/postre.db';
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

declare module 'node:sqlite' {
  interface DatabaseSync {
    transaction<T>(fn: () => T): () => T;
  }
}

/** Minimal stand-in for better-sqlite3's db.transaction(fn) - wraps fn in BEGIN/COMMIT. */
export function transaction<T>(fn: () => T): () => T {
  return () => {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
}
// Attach as a method so db.transaction(fn) works like better-sqlite3 callers expect.
(db as any).transaction = transaction;

export function migrate(): void {
  db.exec(`
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

  const adminCount = (db.prepare('SELECT COUNT(*) c FROM admins').get() as any).c;
  // v3: admin account management — role column (ADMIN | STAFF)
  const adminCols = (db.prepare('PRAGMA table_info(admins)').all() as any[]).map((c: any) => c.name);
  if (!adminCols.includes('role')) {
    db.exec(`ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'ADMIN';`);
  }

  if (adminCount === 0) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'change-me', 10);
    db.prepare('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)')
      .run(process.env.ADMIN_USER || 'admin', hash, 'ADMIN');
  }

  const slotCount = (db.prepare('SELECT COUNT(*) c FROM time_slots').get() as any).c;
  if (slotCount === 0) {
    const ins = db.prepare('INSERT INTO time_slots (label, sort_order, max_capacity) VALUES (?, ?, ?)');
    ['10:00 AM', '12:00 PM', '2:00 PM', '4:00 PM', '6:00 PM'].forEach((l, i) => ins.run(l, i, 5));
  }
  const bhCount = (db.prepare('SELECT COUNT(*) c FROM business_hours').get() as any).c;
  if (bhCount === 0) {
    const ins = db.prepare('INSERT INTO business_hours (day_of_week, open_time, close_time, closed) VALUES (?, ?, ?, ?)');
    for (let d = 0; d < 7; d++) ins.run(d, '10:00', '19:00', d === 0 ? 1 : 0);
  }
  const catCount = (db.prepare('SELECT COUNT(*) c FROM categories').get() as any).c;
  if (catCount === 0) {
    const ins = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)');
    ['Chicken', 'Pork', 'Beef', 'Noodles', 'Bilao', 'Desserts'].forEach((c, i) => ins.run(c, i));
  }

  // ---- v2: fixed / custom packages + default dish per slot ----
  const addCol = (table: string, col: string, ddl: string) => {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c: any) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} INTEGER ${ddl};`);
  };
  addCol('packages', 'is_fixed', 'DEFAULT 0');
  addCol('packages', 'is_custom', 'DEFAULT 0');
  addCol('package_options', 'is_default', 'DEFAULT 0');

  // Give every slot without a default its first option as the pre-selected dish.
  db.exec(`UPDATE package_options SET is_default = 1 WHERE id IN (
    SELECT po.id FROM package_options po
    WHERE po.is_default = 0
      AND NOT EXISTS (SELECT 1 FROM package_options po3 WHERE po3.slot_id = po.slot_id AND po3.is_default = 1)
      AND po.id = (SELECT po2.id FROM package_options po2 WHERE po2.slot_id = po.slot_id ORDER BY po2.id LIMIT 1)
  );`);

  // Guarantee a "build your own" package exists so customers can create a custom package.
  const customCount = (db.prepare('SELECT COUNT(*) c FROM packages WHERE is_custom = 1 AND active = 1').get() as any).c;
  if (customCount === 0) {
    const out = db.prepare(`INSERT INTO packages (name, description, base_price, selections, is_custom)
      VALUES (?, ?, ?, ?, 1)`).run('Build Your Own Package', 'Create your own package - choose any 4 dishes', 1500, 4);
    const pkgId = Number(out.lastInsertRowid);
    const insSlot = db.prepare('INSERT INTO package_slots (package_id, slot_number) VALUES (?, ?)');
    for (let i = 1; i <= 4; i++) insSlot.run(pkgId, i);
  }

  // Make sure there is at least one ready-to-order fixed package (fully filled slots, all menu dishes allowed).
  const fixedCount = (db.prepare('SELECT COUNT(*) c FROM packages WHERE is_fixed = 1 AND active = 1').get() as any).c;
  if (fixedCount === 0) {
    const candidates = db.prepare('SELECT * FROM packages WHERE active = 1 AND is_custom = 0 ORDER BY id').all() as any[];
    for (const p of candidates) {
      const slots = db.prepare('SELECT * FROM package_slots WHERE package_id = ?').all(p.id) as any[];
      const complete = slots.length === p.selections && slots.every((s: any) =>
        (db.prepare('SELECT COUNT(*) c FROM package_options WHERE slot_id = ?').get(s.id) as any).c > 0);
      if (complete) {
        db.prepare('UPDATE packages SET is_fixed = 1 WHERE id = ?').run(p.id);
        break;
      }
    }
  }
}
