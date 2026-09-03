/**
 * Seed script: Copy all data from local SQLite to Supabase Postgres.
 * Run this after setting DATABASE_URL in your .env file.
 *
 * Usage: npx tsx scripts/seed-to-supabase.ts
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

  // Tables in dependency order (parents before children)
  const tables: Array<{ name: string; columns: string[]; conflict: string }> = [
    { name: 'categories', columns: ['id', 'name', 'sort_order', 'active'], conflict: 'id' },
    { name: 'products', columns: ['id', 'category_id', 'name', 'description', 'photo_url', 'sort_order', 'active', 'unavailable'], conflict: 'id' },
    { name: 'product_variants', columns: ['id', 'product_id', 'size', 'price'], conflict: 'id' },
    { name: 'packages', columns: ['id', 'name', 'description', 'photo_url', 'base_price', 'selections', 'active', 'discount', 'is_fixed', 'is_custom'], conflict: 'id' },
    { name: 'package_slots', columns: ['id', 'package_id', 'slot_number'], conflict: 'id' },
    { name: 'package_options', columns: ['id', 'slot_id', 'product_id', 'upgrade_price', 'size_upgrade_price', 'is_default'], conflict: 'id' },
    { name: 'delivery_areas', columns: ['id', 'name', 'fee', 'active'], conflict: 'id' },
    { name: 'time_slots', columns: ['id', 'label', 'sort_order', 'max_capacity', 'active'], conflict: 'id' },
    { name: 'business_hours', columns: ['day_of_week', 'open_time', 'close_time', 'closed'], conflict: 'day_of_week' },
    { name: 'admins', columns: ['id', 'username', 'password_hash', 'created_at', 'role'], conflict: 'id' },
  ];

  let totalRows = 0;

  for (const table of tables) {
    let rows: any[];
    try {
      rows = sq.prepare(`SELECT * FROM ${table.name}`).all() as any[];
    } catch (e: any) {
      console.log(`  SKIP ${table.name}: ${e.message}`);
      continue;
    }

    if (rows.length === 0) {
      console.log(`  ${table.name}: 0 rows (empty)`);
      continue;
    }

    let inserted = 0;
    for (const row of rows) {
      // Exclude 'id' column - let the database auto-generate it (GENERATED ALWAYS AS IDENTITY)
      const cols = table.columns.filter((c) => row[c] !== undefined && c !== 'id');
      const vals = cols.map((c) => {
        const v = row[c];
        if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
        if (typeof v === 'bigint') return Number(v);
        return v;
      });
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const updateCols = cols.filter((c) => c !== 'id' && c !== table.conflict);
      const update = updateCols.length > 0
        ? updateCols.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ')
        : `"${table.conflict}" = EXCLUDED."${table.conflict}"`;

      const sql = `INSERT INTO "${table.name}" ("${cols.join('", "')}") VALUES (${placeholders})
        ON CONFLICT ("${table.conflict}") DO UPDATE SET ${update}`;

      try {
        await pg.query(sql, vals);
        inserted++;
      } catch (e: any) {
        console.error(`  ERROR inserting into ${table.name}:`, e.message);
      }
    }

    // Sync sequence past the highest SQLite id to avoid future conflicts
    if (table.columns.includes('id') && rows.length > 0) {
      try {
        const maxId = Math.max(...rows.map((r: any) => Number(r.id) || 0));
        await pg.query(
          `SELECT setval(pg_get_serial_sequence('${table.name}', 'id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM "${table.name}"), ${maxId}))`
        );
      } catch (e) {
        // Sequence might not exist for all tables
      }
    }

    console.log(`  ${table.name}: ${inserted}/${rows.length} rows`);
    totalRows += inserted;
  }

  console.log(`\n✅ Migration complete! ${totalRows} total rows seeded.`);

  // Verify counts
  console.log('\n--- Verification ---');
  for (const table of tables) {
    try {
      const res = await pg.query(`SELECT COUNT(*) as c FROM "${table.name}"`);
      console.log(`  ${table.name}: ${res.rows[0].c} rows`);
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
