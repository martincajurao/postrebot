/**
 * Fix script: Ensure Supabase packages have correct discounts and default items
 * from the local SQLite database.
 *
 * Usage: npx tsx src/db/fix-packages-supabase.ts
 */

import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { poolOf, query, one, run } from './pg';

const SQLITE = process.env.DATABASE_FILE || './data/postre.db';

async function main() {
  if (!process.env.DATABASE_URL?.trim()) {
    console.error('ERROR: DATABASE_URL is not set.');
    process.exit(1);
  }

  const sq = new DatabaseSync(SQLITE, { readOnly: true });
  const pg = poolOf();

  console.log('Connecting to Supabase Postgres...');
  await pg.query('SELECT 1');
  console.log('Connected!');

  // Map Supabase packages by name
  const existingPkgs = await pg.query('SELECT id, name, discount, is_fixed, is_custom FROM packages');
  const pgPkgByName = new Map<string, any>();
  for (const row of existingPkgs.rows) {
    pgPkgByName.set(row.name, { id: Number(row.id), discount: Number(row.discount), is_fixed: Number(row.is_fixed), is_custom: Number(row.is_custom) });
  }

  // Map Supabase slots by package_id
  const existingSlots = await pg.query('SELECT id, package_id, slot_number FROM package_slots');
  const pgSlotsByPkgId = new Map<number, any[]>();
  for (const row of existingSlots.rows) {
    const list = pgSlotsByPkgId.get(Number(row.package_id)) || [];
    list.push({ id: Number(row.id), slot_number: Number(row.slot_number) });
    pgSlotsByPkgId.set(Number(row.package_id), list);
  }

  // Map Supabase options by slot_id
  const existingOptions = await pg.query('SELECT id, slot_id, product_id, is_default FROM package_options');
  const pgOptionsBySlotId = new Map<number, any[]>();
  for (const row of existingOptions.rows) {
    const list = pgOptionsBySlotId.get(Number(row.slot_id)) || [];
    list.push({ id: Number(row.id), product_id: Number(row.product_id), is_default: Number(row.is_default) });
    pgOptionsBySlotId.set(Number(row.slot_id), list);
  }

  // Read SQLite data
  const sqlitePackages = sq.prepare('SELECT id, name, base_price, discount, selections, is_fixed, is_custom FROM packages').all() as any[];
  const sqliteSlots = sq.prepare('SELECT id, package_id, slot_number FROM package_slots').all() as any[];
  const sqliteOptions = sq.prepare('SELECT id, slot_id, product_id, is_default FROM package_options').all() as any[];

  // Map SQLite slot_id -> default product_id
  const sqliteDefaultsBySlotId = new Map<number, number>();
  for (const o of sqliteOptions) {
    if (Number(o.is_default) === 1) sqliteDefaultsBySlotId.set(Number(o.slot_id), Number(o.product_id));
  }

  let packagesUpdated = 0;
  let defaultsFixed = 0;

  // 1. Update package discounts and flags
  console.log('--- Updating package discounts and flags ---');
  for (const pkg of sqlitePackages) {
    const pgPkg = pgPkgByName.get(pkg.name);
    if (!pgPkg) { console.log(`  SKIP: ${pkg.name} not in Supabase`); continue; }
    const d = Number(pkg.discount) || 0, f = Number(pkg.is_fixed) || 0, c = Number(pkg.is_custom) || 0;
    if (pgPkg.discount !== d || pgPkg.is_fixed !== f || pgPkg.is_custom !== c) {
      await run('UPDATE packages SET discount=$1, is_fixed=$2, is_custom=$3 WHERE id=$4', [d, f, c, pgPkg.id]);
      console.log(`  UPDATED ${pkg.name}: discount=${d}, is_fixed=${f}, is_custom=${c}`);
      packagesUpdated++;
    } else {
      console.log(`  OK ${pkg.name}: discount=${d}`);
    }
  }

  // 2. Fix default items per slot
  console.log('\n--- Fixing default items ---');
  for (const pkg of sqlitePackages) {
    const pgPkg = pgPkgByName.get(pkg.name);
    if (!pgPkg) continue;
    const sqSlots = sqliteSlots.filter((s: any) => Number(s.package_id) === Number(pkg.id));
    const pgSlots = pgSlotsByPkgId.get(pgPkg.id) || [];
    for (const sqSlot of sqSlots) {
      const pgSlot = pgSlots.find((s) => s.slot_number === Number(sqSlot.slot_number));
      if (!pgSlot) continue;
      const expectedProd = sqliteDefaultsBySlotId.get(Number(sqSlot.id));
      if (!expectedProd) continue;
      const opts = pgOptionsBySlotId.get(pgSlot.id) || [];
      const cur = opts.find((o) => o.is_default === 1);
      if (cur && cur.product_id === expectedProd) continue;
      if (cur) await run('UPDATE package_options SET is_default=0 WHERE id=$1', [cur.id]);
      const target = opts.find((o) => o.product_id === expectedProd);
      if (target) {
        await run('UPDATE package_options SET is_default=1 WHERE id=$1', [target.id]);
        console.log(`  FIXED slot ${sqSlot.slot_number} of ${pkg.name}`);
        defaultsFixed++;
      }
    }
  }

  // 3. Fallback: every slot needs a default
  console.log('\n--- Fallback defaults ---');
  const allSlots = await pg.query('SELECT id, slot_number, package_id FROM package_slots');
  for (const slot of allSlots.rows) {
    const opts = pgOptionsBySlotId.get(Number(slot.id)) || [];
    if (!opts.some((o) => o.is_default === 1) && opts.length > 0) {
      await run('UPDATE package_options SET is_default=1 WHERE id=$1', [opts[0].id]);
      defaultsFixed++;
    }
  }

  console.log(`\nDone: ${packagesUpdated} packages updated, ${defaultsFixed} defaults fixed.`);
  sq.close();
  await pg.end();
  process.exit(0);
}

main().catch((e) => { console.error('Fix failed:', e); process.exit(1); });
