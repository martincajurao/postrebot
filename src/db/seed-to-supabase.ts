/**
 * Seed script: Copy all data from local SQLite to Supabase Postgres.
 * Run this after setting DATABASE_URL in your .env file.
 *
 * Usage: npm run db:seed:supabase
 */

import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { poolOf, query, one, run } from './pg';

const SQLITE = process.env.DATABASE_FILE || './data/postre.db';

async function main() {
  if (!process.env.DATABASE_URL?.trim()) {
    console.error('ERROR: DATABASE_URL is not set. Please add it to your .env file.');
    console.error('Get it from: Supabase Dashboard > Settings > Database > Connection pooling');
    process.exit(1);
  }

  const sq = new DatabaseSync(SQLITE, { readOnly: true });
  const pg = poolOf();

  console.log('Connecting to Supabase Postgres...');
  await pg.query('SELECT 1');
  console.log('Connected!\n');

  // Run migrations first
  console.log('Running schema migrations...');
  const { migrate } = await import('./postgres');
  await migrate();
  console.log('Schema ensured.\n');

  // ID mappings
  const categoryMap = new Map<number, number>();
  const productMap = new Map<number, number>();
  const packageMap = new Map<number, number>();
  const slotMap = new Map<number, number>();

  let totalRows = 0;

  // 1. Categories - fetch existing and build map
  console.log('Seeding categories...');
  const existingCats = await pg.query('SELECT id, name FROM categories');
  for (const row of existingCats.rows) {
    categoryMap.set(row.name, Number(row.id));
  }
  const categories = sq.prepare('SELECT * FROM categories').all() as any[];
  for (const row of categories) {
    if (categoryMap.has(row.name)) {
      // Already exists, use existing ID
      categoryMap.set(Number(row.id), categoryMap.get(row.name)!);
      continue;
    }
    const res = await pg.query(
      'INSERT INTO categories (name, sort_order, active) VALUES ($1, $2, $3) RETURNING id',
      [row.name, row.sort_order, row.active]
    );
    const newId = Number(res.rows[0].id);
    categoryMap.set(Number(row.id), newId);
    categoryMap.set(row.name, newId);
  }
  console.log(`  categories: ${categories.length} rows (mapped: ${categoryMap.size})`);
  totalRows += categories.length;

  // 2. Products - fetch existing and build map
  console.log('Seeding products...');
  const existingProds = await pg.query('SELECT id, name FROM products');
  for (const row of existingProds.rows) {
    productMap.set(row.name, Number(row.id));
  }
  const products = sq.prepare('SELECT * FROM products').all() as any[];
  for (const row of products) {
    if (productMap.has(row.name)) {
      // Already exists, use existing ID
      productMap.set(Number(row.id), productMap.get(row.name)!);
      continue;
    }
    const newCategoryId = categoryMap.get(Number(row.category_id));
    const res = await pg.query(
      'INSERT INTO products (category_id, name, description, photo_url, sort_order, active, unavailable) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [newCategoryId, row.name, row.description, row.photo_url, row.sort_order, row.active, row.unavailable]
    );
    const newId = Number(res.rows[0].id);
    productMap.set(Number(row.id), newId);
    productMap.set(row.name, newId);
  }
  console.log(`  products: ${products.length} rows`);
  totalRows += products.length;

  // 3. Product Variants
  console.log('Seeding product_variants...');
  const variants = sq.prepare('SELECT * FROM product_variants').all() as any[];
  for (const row of variants) {
    const newProductId = productMap.get(Number(row.product_id));
    if (!newProductId) {
      console.log(`  SKIP variant: product_id ${row.product_id} not found`);
      continue;
    }
    await pg.query(
      'INSERT INTO product_variants (product_id, size, price) VALUES ($1, $2, $3) ON CONFLICT (product_id, size) DO UPDATE SET price = EXCLUDED.price',
      [newProductId, row.size, row.price]
    );
  }
  console.log(`  product_variants: ${variants.length} rows`);
  totalRows += variants.length;

  // 4. Packages - fetch existing and build map
  console.log('Seeding packages...');
  const existingPkgs = await pg.query('SELECT id, name FROM packages');
  for (const row of existingPkgs.rows) {
    packageMap.set(row.name, Number(row.id));
  }
  const packages = sq.prepare('SELECT * FROM packages').all() as any[];
  for (const row of packages) {
    if (packageMap.has(row.name)) {
      // Already exists, use existing ID
      packageMap.set(Number(row.id), packageMap.get(row.name)!);
      continue;
    }
    const res = await pg.query(
      'INSERT INTO packages (name, description, photo_url, base_price, selections, active, discount, is_fixed, is_custom) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
      [row.name, row.description, row.photo_url, row.base_price, row.selections, row.active, row.discount, row.is_fixed, row.is_custom]
    );
    const newId = Number(res.rows[0].id);
    packageMap.set(Number(row.id), newId);
    packageMap.set(row.name, newId);
  }
  console.log(`  packages: ${packages.length} rows`);
  totalRows += packages.length;

  // 5. Package Slots
  console.log('Seeding package_slots...');
  const slots = sq.prepare('SELECT * FROM package_slots').all() as any[];
  for (const row of slots) {
    const newPackageId = packageMap.get(Number(row.package_id));
    if (!newPackageId) {
      console.log(`  SKIP slot: package_id ${row.package_id} not found`);
      continue;
    }
    const res = await pg.query(
      'INSERT INTO package_slots (package_id, slot_number) VALUES ($1, $2) RETURNING id',
      [newPackageId, row.slot_number]
    );
    const newId = Number(res.rows[0].id);
    slotMap.set(Number(row.id), newId);
  }
  console.log(`  package_slots: ${slots.length} rows`);
  totalRows += slots.length;

  // 6. Package Options
  console.log('Seeding package_options...');
  const options = sq.prepare('SELECT * FROM package_options').all() as any[];
  for (const row of options) {
    const newSlotId = slotMap.get(Number(row.slot_id));
    const newProductId = productMap.get(Number(row.product_id));
    if (!newSlotId || !newProductId) {
      console.log(`  SKIP option: slot_id ${row.slot_id} or product_id ${row.product_id} not found`);
      continue;
    }
    await pg.query(
      'INSERT INTO package_options (slot_id, product_id, upgrade_price, size_upgrade_price, is_default) VALUES ($1, $2, $3, $4, $5)',
      [newSlotId, newProductId, row.upgrade_price, row.size_upgrade_price, row.is_default]
    );
  }
  console.log(`  package_options: ${options.length} rows`);
  totalRows += options.length;

  // 7. Delivery Areas
  console.log('Seeding delivery_areas...');
  const areas = sq.prepare('SELECT * FROM delivery_areas').all() as any[];
  for (const row of areas) {
    await pg.query(
      'INSERT INTO delivery_areas (name, fee, active) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [row.name, row.fee, row.active]
    );
  }
  console.log(`  delivery_areas: ${areas.length} rows`);
  totalRows += areas.length;

  // 8. Time Slots
  console.log('Seeding time_slots...');
  const timeSlots = sq.prepare('SELECT * FROM time_slots').all() as any[];
  for (const row of timeSlots) {
    await pg.query(
      'INSERT INTO time_slots (label, sort_order, max_capacity, active) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [row.label, row.sort_order, row.max_capacity, row.active]
    );
  }
  console.log(`  time_slots: ${timeSlots.length} rows`);
  totalRows += timeSlots.length;

  // 9. Business Hours
  console.log('Seeding business_hours...');
  const hours = sq.prepare('SELECT * FROM business_hours').all() as any[];
  for (const row of hours) {
    await pg.query(
      'INSERT INTO business_hours (day_of_week, open_time, close_time, closed) VALUES ($1, $2, $3, $4) ON CONFLICT (day_of_week) DO UPDATE SET open_time = EXCLUDED.open_time, close_time = EXCLUDED.close_time, closed = EXCLUDED.closed',
      [row.day_of_week, row.open_time, row.close_time, row.closed]
    );
  }
  console.log(`  business_hours: ${hours.length} rows`);
  totalRows += hours.length;

  // 10. Admins
  console.log('Seeding admins...');
  const admins = sq.prepare('SELECT * FROM admins').all() as any[];
  for (const row of admins) {
    await pg.query(
      'INSERT INTO admins (username, password_hash, created_at, role) VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash',
      [row.username, row.password_hash, row.created_at, row.role]
    );
  }
  console.log(`  admins: ${admins.length} rows`);
  totalRows += admins.length;

  console.log(`\n\u2705 Migration complete! ${totalRows} total rows seeded.`);

  // Verify counts
  console.log('\n--- Verification ---');
  const tables = ['categories', 'products', 'product_variants', 'packages', 'package_slots', 'package_options', 'delivery_areas', 'time_slots', 'business_hours', 'admins'];
  for (const table of tables) {
    try {
      const res = await pg.query(`SELECT COUNT(*) as c FROM ${table}`);
      console.log(`  ${table}: ${res.rows[0].c} rows`);
    } catch (e) {
      // Table might not exist
    }
  }

  sq.close();
  await pg.end();
  process.exit(0);
}

main().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});