/**
 * Read-only dump of the tables that feed the admin panel — used to spot
 * seeded/leftover rows. Run: npx tsx -r dotenv/config scripts/dump-admin-tables.ts
 */
import 'dotenv/config';
import { supa } from '../src/db/supabase';

(async () => {
  const db = supa();
  const q = async (name: string, table: string, cols: string, order = 'id', limit = 50) => {
    const { data, error } = await db.from(table).select(cols).order(order, { ascending: true }).limit(limit);
    if (error) { console.log(`\n== ${name}: ERROR ${error.message}`); return; }
    console.log(`\n== ${name} (${(data || []).length} rows shown) ==`);
    for (const row of data || []) console.log(JSON.stringify(row));
  };

  await q('customers', 'customers', 'id, psid, name, phone, address', 'id', 100);
  await q('orders', 'orders', 'id, order_number, customer_id, order_type, address, total, status, created_at', 'id', 200);
  await q('categories', 'categories', 'id, name, sort_order, active');
  await q('delivery_areas', 'delivery_areas', 'id, name, fee, active');
  await q('time_slots', 'time_slots', 'id, label, sort_order, active');
  await q('packages', 'packages', 'id, name, is_custom, is_fixed, active');
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
