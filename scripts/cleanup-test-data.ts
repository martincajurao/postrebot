/**
 * One-off / reusable cleanup of seeded + test-leftover rows:
 *  - customers with psid 'test_session_*' or 'TEST_PSID_1' (created by
 *    test-webview-crud.ts runs; they pile up in Admin → Customers)
 *  - their carts, orders, order lines, payments and conversation states
 *  - the seeded delivery_areas rows (fee system moved to distance-based
 *    delivery tiers + branches; all seeded areas were deactivated anyway)
 * Run:        npx tsx -r dotenv/config scripts/cleanup-test-data.ts
 * Preview:    DRY_RUN=1 npx tsx -r dotenv/config scripts/cleanup-test-data.ts
 */
import 'dotenv/config';
import { supa } from '../src/db/supabase';

const DRY = process.env.DRY_RUN === '1';
const TEST_PSID_EXACT = ['TEST_PSID_1'];

(async () => {
  const db = supa();
  const deleted: Record<string, number> = {};

  const del = async (table: string, build: () => any) => {
    let q = build();
    if (DRY) q = q.select('id');
    const { data, error } = await q;
    if (error) { console.warn(`  ! ${table}: ${error.message} (skipped)`); return; }
    const n = Array.isArray(data) ? data.length : 0;
    deleted[table] = (deleted[table] || 0) + n;
    if (DRY && n > 0) console.log(`  ~ would delete ${n} row(s) from ${table}`);
  };

  // 1. Find the test customer ids (pattern match + exact legacy psids).
  const { data: testCusts, error: custErr } = await db
    .from('customers')
    .select('id, psid, name')
    .or(`psid.like.test_session_%,${TEST_PSID_EXACT.map((p) => `psid.eq.${p}`).join(',')}`);
  if (custErr) { console.error('Failed to list test customers:', custErr.message); process.exit(1); }
  const ids = (testCusts || []).map((c: any) => Number(c.id));
  const psids = (testCusts || []).map((c: any) => String(c.psid));
  console.log(`Found ${ids.length} test customer row(s)${DRY ? ' (DRY RUN — nothing deleted)' : ''}`);
  for (const c of testCusts || []) console.log(`  - #${c.id} ${c.psid} (${c.name || 'unnamed'})`);

  if (ids.length > 0) {
    // 2. Orders belonging to them (plus dependent lines/payments).
    const { data: testOrders } = await db.from('orders').select('id').in('customer_id', ids);
    const orderIds = (testOrders || []).map((o: any) => Number(o.id));
    if (orderIds.length > 0) {
      await del('order_items', () => db.from('order_items').delete().in('order_id', orderIds));
      await del('order_package_items', () => db.from('order_package_items').delete().in('order_id', orderIds));
      await del('order_status_history', () => db.from('order_status_history').delete().in('order_id', orderIds));
      await del('payments', () => db.from('payments').delete().in('order_id', orderIds));
      await del('order_ratings', () => db.from('order_ratings').delete().in('order_id', orderIds));
      await del('reservations', () => db.from('reservations').delete().in('order_id', orderIds));
      await del('orders', () => db.from('orders').delete().in('id', orderIds));
    }
    // 3. Carts & cart items — cart_items has NO customer_id column; lines hang
    //    off carts(id), and carts are keyed by psid (this exact mismatch is why
    //    test-webview-crud.ts's old cleanup silently failed and rows piled up).
    const { data: cartRows } = await db.from('carts').select('id').in('psid', psids);
    const cartIds = (cartRows || []).map((c: any) => Number(c.id));
    if (cartIds.length > 0) {
      await del('cart_items', () => db.from('cart_items').delete().in('cart_id', cartIds));
      await del('carts', () => db.from('carts').delete().in('id', cartIds));
    }
    // 4. Conversation states (keyed by psid — no id column, count via pre-select).
    const { data: convRows } = await db.from('conversation_states').select('psid').in('psid', psids);
    const convCount = (convRows || []).length;
    if (convCount > 0) {
      if (DRY) console.log(`  ~ would delete ${convCount} row(s) from conversation_states`);
      else {
        const { error: convErr } = await db.from('conversation_states').delete().in('psid', psids);
        if (convErr) console.warn(`  ! conversation_states: ${convErr.message} (skipped)`);
        else deleted['conversation_states'] = convCount;
      }
    }
    // 5. The customers themselves.
    await del('customers', () => db.from('customers').delete().in('id', ids));
  }

  // 5. Seeded delivery_areas (all deactivated; obsolete area-fee system).
  const { data: areas } = await db.from('delivery_areas').select('id, name, active');
  if (areas && areas.length > 0) {
    console.log(`Found ${areas.length} seeded delivery area(s): ${areas.map((a: any) => a.name).join(', ')}`);
    await del('delivery_areas', () => db.from('delivery_areas').delete().not('id', 'is', null));
  }

  console.log(DRY ? '\nDRY RUN complete — re-run without DRY_RUN=1 to delete.' : '\nCleanup done:', deleted);
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
