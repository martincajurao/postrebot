import bcrypt from 'bcryptjs';
import { query, one, many, run, insertReturningId } from './pg';

/**
 * Postgres schema (Supabase). Converted from the original SQLite DDL:
 *  - INTEGER PRIMARY KEY AUTOINCREMENT → GENERATED ALWAYS AS IDENTITY
 *  - datetime('now') defaults          → now()
 *  - INTEGER booleans kept (0/1) to minimise app-code changes
 */
export async function migrate(): Promise<void> {
  await query(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (now()::text),
    role TEXT NOT NULL DEFAULT 'ADMIN'
  );
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    psid TEXT UNIQUE NOT NULL,
    name TEXT, phone TEXT, address TEXT,
    created_at TEXT DEFAULT (now()::text)
  );
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    name TEXT NOT NULL, description TEXT, photo_url TEXT,
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    unavailable INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS product_variants (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    size TEXT NOT NULL, price INTEGER NOT NULL,
    UNIQUE(product_id, size)
  );
  CREATE TABLE IF NOT EXISTS packages (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL, description TEXT, photo_url TEXT,
    base_price INTEGER NOT NULL, selections INTEGER NOT NULL,
    active INTEGER DEFAULT 1,
    discount INTEGER NOT NULL DEFAULT 0,
    is_fixed INTEGER DEFAULT 0,
    is_custom INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS package_slots (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
    slot_number INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS package_options (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slot_id INTEGER NOT NULL REFERENCES package_slots(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    upgrade_price INTEGER DEFAULT 0,
    size_upgrade_price INTEGER DEFAULT 0,
    is_default INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS carts (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    psid TEXT UNIQUE NOT NULL,
    updated_at TEXT DEFAULT (now()::text)
  );
  CREATE TABLE IF NOT EXISTS food_packs (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL, description TEXT, photo_url TEXT,
    price INTEGER NOT NULL,
    serves TEXT,
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS cart_items (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cart_id INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
    product_id INTEGER, package_id INTEGER, food_pack_id INTEGER REFERENCES food_packs(id),
    variant_size TEXT, quantity INTEGER NOT NULL DEFAULT 1,
    slot_choices TEXT
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_number TEXT UNIQUE NOT NULL,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    order_type TEXT NOT NULL, address TEXT,
    delivery_fee INTEGER DEFAULT 0,
    subtotal INTEGER NOT NULL, total INTEGER NOT NULL,
    fulfillment_date TEXT, time_slot TEXT,
    payment_method TEXT, payment_status TEXT DEFAULT 'UNPAID',
    status TEXT DEFAULT 'PENDING', notes TEXT,
    created_at TEXT DEFAULT (now()::text)
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER, package_id INTEGER, food_pack_id INTEGER REFERENCES food_packs(id),
    name TEXT NOT NULL, variant_size TEXT,
    quantity INTEGER NOT NULL, unit_price INTEGER NOT NULL,
    line_total INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS order_package_items (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    slot_number INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    upgrade_price INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS order_status_history (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    changed_at TEXT DEFAULT (now()::text)
  );
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id),
    customer_name TEXT NOT NULL, phone TEXT,
    res_date TEXT NOT NULL, time_slot TEXT NOT NULL,
    status TEXT DEFAULT 'PENDING', notes TEXT,
    created_at TEXT DEFAULT (now()::text),
    UNIQUE(res_date, time_slot, customer_name)
  );
  CREATE TABLE IF NOT EXISTS delivery_areas (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    fee INTEGER NOT NULL,
    active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS business_hours (
    day_of_week INTEGER PRIMARY KEY,
    open_time TEXT, close_time TEXT,
    closed INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS blocked_dates (
    date TEXT PRIMARY KEY, reason TEXT
  );
  CREATE TABLE IF NOT EXISTS time_slots (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    label TEXT UNIQUE NOT NULL,
    sort_order INTEGER DEFAULT 0,
    max_capacity INTEGER DEFAULT 5,
    active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    method TEXT, amount INTEGER NOT NULL, status TEXT NOT NULL,
    recorded_at TEXT DEFAULT (now()::text)
  );
  CREATE TABLE IF NOT EXISTS uploads (
    name TEXT PRIMARY KEY, mime TEXT NOT NULL, public_url TEXT
  );
  CREATE TABLE IF NOT EXISTS conversation_states (
    psid TEXT PRIMARY KEY, state TEXT NOT NULL,
    context_json TEXT,
    updated_at TEXT DEFAULT (now()::text)
  );
  `);

  // v9: Web Push subscriptions for admin notifications.
  await run(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT DEFAULT (now()::text),
      updated_at TEXT DEFAULT (now()::text)
    );
  `);

  await seedDefaults();
}

async function seedDefaults(): Promise<void> {
  // Root admin: env always wins on boot (same policy as the SQLite version).
  const envUser = (process.env.ADMIN_USER || 'admin').trim();
  const envPass = process.env.ADMIN_PASSWORD;
  if (envPass) {
    const root = await one('SELECT * FROM admins WHERE username = $1', [envUser]);
    if (root) {
      if (!bcrypt.compareSync(envPass, root.password_hash)) {
        await run('UPDATE admins SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(envPass, 10), root.id]);
        console.log(`[migrate] root admin "${envUser}" password synced from ADMIN_PASSWORD env`);
      }
    } else {
      await run("INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, 'ADMIN')", [envUser, bcrypt.hashSync(envPass, 10)]);
      console.log(`[migrate] root admin "${envUser}" created from ADMIN_USER/ADMIN_PASSWORD env`);
    }
  }

  if ((await one<{ c: number }>('SELECT COUNT(*)::int AS c FROM time_slots'))!.c === 0) {
    let i = 0;
    for (const l of ['10:00 AM', '12:00 PM', '2:00 PM', '4:00 PM', '6:00 PM']) {
      await run('INSERT INTO time_slots (label, sort_order, max_capacity) VALUES ($1, $2, 5)', [l, i++]);
    }
  }
  if ((await one<{ c: number }>('SELECT COUNT(*)::int AS c FROM business_hours'))!.c === 0) {
    for (let d = 0; d < 7; d++) {
      await run('INSERT INTO business_hours (day_of_week, open_time, close_time, closed) VALUES ($1, $2, $3, $4)', [d, '10:00', '19:00', d === 0 ? 1 : 0]);
    }
  }
  if ((await one<{ c: number }>('SELECT COUNT(*)::int AS c FROM delivery_areas'))!.c === 0) {

    const areas: [string, number][] = [
      ['Magarao',   50],
      ['Naga City',  100],
      ['Pili',       150],
      ['Other Area',  200],
    ];
    for (const [name, fee] of areas) {
      await run('INSERT INTO delivery_areas (name,fee) VALUES ($1,$2)', [name, fee]);
    }
  }
  if ((await one<{ c: number }>('SELECT COUNT(*)::int AS c FROM categories'))!.c === 0) {
    let i = 0;
    for (const c of ['Chicken', 'Pork', 'Beef', 'Noodles', 'Bilao', 'Desserts']) {
      await run('INSERT INTO categories (name, sort_order) VALUES ($1, $2)', [c, i++]);
    }
  }

  // Give every slot without a default its first option as the pre-selected dish.
  await query(`UPDATE package_options SET is_default = 1 WHERE id IN (
    SELECT po.id FROM package_options po
    WHERE po.is_default = 0
      AND NOT EXISTS (SELECT 1 FROM package_options po3 WHERE po3.slot_id = po.slot_id AND po3.is_default = 1)
      AND po.id = (SELECT po2.id FROM package_options po2 WHERE po2.slot_id = po.slot_id ORDER BY po2.id LIMIT 1)
  )`);

  // Guarantee a "build your own" package exists.
  if ((await one<{ c: number }>('SELECT COUNT(*)::int AS c FROM packages WHERE is_custom = 1 AND active = 1'))!.c === 0) {
    const pkgId = await insertReturningId(
      `INSERT INTO packages (name, description, base_price, selections, is_custom)
       VALUES ($1, $2, $3, $4, 1) RETURNING id`,
      ['Build Your Own Package', 'Create your own package - choose any 4 dishes', 1500, 4]
    );
    for (let i = 1; i <= 4; i++) {
      await run('INSERT INTO package_slots (package_id, slot_number) VALUES ($1, $2)', [pkgId, i]);
    }
  }

  // At least one ready-to-order fixed package.
  if ((await one<{ c: number }>('SELECT COUNT(*)::int AS c FROM packages WHERE is_fixed = 1 AND active = 1'))!.c === 0) {
    const candidates = await many<any>('SELECT * FROM packages WHERE active = 1 AND is_custom = 0 ORDER BY id');
    for (const p of candidates) {
      const slots = await many<any>('SELECT * FROM package_slots WHERE package_id = $1', [p.id]);
      const complete = slots.length === p.selections &&
        (await many('SELECT 1 FROM package_options po JOIN package_slots ps ON ps.id = po.slot_id WHERE ps.package_id = $1 GROUP BY po.slot_id', [p.id])).length === slots.length;
      if (complete) {
        await run('UPDATE packages SET is_fixed = 1 WHERE id = $1', [p.id]);
        break;
      }
    }
  }

  // v6: Order ratings table for customer feedback
  await query(`
    CREATE TABLE IF NOT EXISTS order_ratings (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      order_id INTEGER REFERENCES orders(id),
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      feedback TEXT,
      created_at TEXT DEFAULT (now()::text)
    );
  `);

  // v6: Promo codes table for discounts
  await query(`
    CREATE TABLE IF NOT EXISTS promo_codes (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      discount_type TEXT CHECK(discount_type IN ('fixed', 'percent')),
      discount_value INTEGER NOT NULL,
      min_order INTEGER DEFAULT 0,
      max_uses INTEGER,
      used_count INTEGER DEFAULT 0,
      valid_from TEXT,
      valid_until TEXT,
      active INTEGER DEFAULT 1
    );
  `);

  // v6: Add notes column to cart_items for special instructions
  const cartItemCols = (await many<any>('SELECT column_name FROM information_schema.columns WHERE table_name = $1', ['cart_items'])).map((c: any) => c.column_name);
  if (!cartItemCols.includes('notes')) {
    await query(`ALTER TABLE cart_items ADD COLUMN notes TEXT;`);
  }

  // v8: Food packs — simple fixed-price bundles, ordered as-is (no slots/customization).
  await query(`
    CREATE TABLE IF NOT EXISTS food_packs (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL, description TEXT, photo_url TEXT,
      price INTEGER NOT NULL,
      serves TEXT,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1
    );
  `);
  const cartItemColsV8 = (await many<any>('SELECT column_name FROM information_schema.columns WHERE table_name = $1', ['cart_items'])).map((c: any) => c.column_name);
  if (!cartItemColsV8.includes('food_pack_id')) {
    await query(`ALTER TABLE cart_items ADD COLUMN food_pack_id INTEGER REFERENCES food_packs(id);`);
  }
  const orderItemColsV8 = (await many<any>('SELECT column_name FROM information_schema.columns WHERE table_name = $1', ['order_items'])).map((c: any) => c.column_name);
  if (!orderItemColsV8.includes('food_pack_id')) {
    await query(`ALTER TABLE order_items ADD COLUMN food_pack_id INTEGER REFERENCES food_packs(id);`);
  }

  // v7: product_id on order_package_items so reorders can rebuild the exact
  // slot choices (previously only product_name was stored, making reordered
  // package items unpriceable).
  const opiCols = (await many<any>('SELECT column_name FROM information_schema.columns WHERE table_name = $1', ['order_package_items'])).map((c: any) => c.column_name);
  if (!opiCols.includes('product_id')) {
    await query(`ALTER TABLE order_package_items ADD COLUMN product_id INTEGER;`);
    // Backfill from the matching package_options where still resolvable
    await query(`
      UPDATE order_package_items
      SET product_id = po.product_id
      FROM order_items oi
      JOIN package_slots ps ON ps.package_id = oi.package_id AND ps.slot_number = order_package_items.slot_number
      JOIN package_options po ON po.slot_id = ps.id AND po.product_id IN (
        SELECT p.id FROM products p WHERE p.name = order_package_items.product_name
      )
      WHERE order_package_items.order_item_id = oi.id AND order_package_items.product_id IS NULL`);
  }
}
