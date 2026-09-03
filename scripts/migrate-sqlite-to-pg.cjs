/**
 * One-time migration: copy all data from local SQLite (data/postre.db)
 * into Supabase Postgres (DATABASE_URL). Idempotent — upserts on conflict,
 * safe to re-run. Sequence counters are synced so new inserts don't collide.
 *
 * Usage: node scripts/migrate-sqlite-to-pg.cjs
 */
require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const { Client } = require('pg');

const SQLITE = process.env.DATABASE_FILE || './data/postre.db';

// tables in dependency order (parents before children)
const TABLES = [
  ['admins', ['username', 'password_hash', 'created_at', 'role']],
  ['customers', ['psid', 'name', 'phone', 'address', 'created_at']],
  ['categories', ['name', 'sort_order', 'active']],
  ['products', ['category_id', 'name', 'description', 'photo_url', 'sort_order', 'active', 'unavailable']],
  ['product_variants', ['product_id', 'size', 'price']],
  ['packages', ['name', 'description', 'photo_url', 'base_price', 'selections', 'active', 'discount', 'is_fixed', 'is_custom']],
  ['package_slots', ['package_id', 'slot_number']],
  ['package_options', ['slot_id', 'product_id', 'upgrade_price', 'size_upgrade_price', 'is_default']],
  ['carts', ['psid', 'updated_at']],
  ['cart_items', ['cart_id', 'product_id', 'package_id', 'variant_size', 'quantity', 'slot_choices']],
  ['orders', ['order_number', 'customer_id', 'order_type', 'address', 'delivery_fee', 'subtotal', 'total', 'fulfillment_date', 'time_slot', 'payment_method', 'payment_status', 'status', 'notes', 'created_at']],
  ['order_items', ['order_id', 'product_id', 'package_id', 'name', 'variant_size', 'quantity', 'unit_price', 'line_total']],
  ['order_package_items', ['order_item_id', 'slot_number', 'product_name', 'upgrade_price']],
  ['order_status_history', ['order_id', 'status', 'changed_at']],
  ['reservations', ['order_id', 'customer_name', 'phone', 'res_date', 'time_slot', 'status', 'notes', 'created_at']],
  ['delivery_areas', ['name', 'fee', 'active']],
  ['business_hours', ['day_of_week', 'open_time', 'close_time', 'closed']],
  ['blocked_dates', ['date', 'reason']],
  ['time_slots', ['label', 'sort_order', 'max_capacity', 'active']],
  ['payments', ['order_id', 'method', 'amount', 'status', 'recorded_at']],
  ['uploads', ['name', 'mime', 'public_url']],
  ['conversation_states', ['psid', 'state', 'context_json', 'updated_at']],
];

async function main() {
  const sq = new DatabaseSync(SQLITE, { readOnly: true });
  const cs = (process.env.DATABASE_URL || '').trim();
  if (!cs) throw new Error('DATABASE_URL not set');
  const pg = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  // Schema first
  const { migrate } = require('../dist/db/postgres.js');
  await migrate();
  console.log('schema ensured');

  for (const [table, cols] of TABLES) {
    let rows;
    try {
      rows = sq.prepare(`SELECT * FROM ${table}`).all();
    } catch (e) {
      console.log(`skip ${table}: ${e.message}`);
      continue;
    }
    // Use only columns that exist in both SQLite and the PG schema.
    let pgCols;
    try {
      const res = await pg.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table]);
      pgCols = res.rows.map((r) => r.column_name);
    } catch { pgCols = cols; }
    const use = cols.filter((c) => pgCols.includes(c));
    if (!use.includes('id') && table !== 'blocked_dates' && table !== 'business_hours') {
      // fall back to insert with fresh ids if id column mismatch — not expected
    }
    const allCols = pgCols.filter((c) => c === 'id' || use.includes(c));
    let n = 0;
    for (const row of rows) {
      const vals = allCols.map((c) => {
        const v = row[c];
        if (v instanceof Uint8Array) return Buffer.from(v).toString('base64'); // legacy blob → not used in PG
        if (typeof v === 'bigint') return Number(v);
        return v;
      });
      const placeholders = allCols.map((_, i) => `$${i + 1}`).join(', ');
      const update = allCols.filter((c) => c !== 'id')
        .map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ');
      const sql = `INSERT INTO ${table} ("${allCols.join('", "')}") VALUES (${placeholders})
        ON CONFLICT (${table === 'business_hours' ? 'day_of_week' : table === 'blocked_dates' ? 'date' : 'id'})
        DO UPDATE SET ${update || 'id = EXCLUDED.id'}`;
      await pg.query(sql, vals);
      n++;
    }
    // Sync identity sequence past the imported ids.
    if (allCols.includes('id') && rows.length) {
      await pg.query(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM ${table}), 1))`
      );
    }
    console.log(`${table}: ${n} rows`);
  }

  await pg.end();
  sq.close();
  console.log('migration complete');
}

main().catch((e) => { console.error(e); process.exit(1); });
