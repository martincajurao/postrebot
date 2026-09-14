/**
 * One-time cleanup: the packages table ended up with TWO identical
 * "Build Your Own Package" rows (both is_custom = 1). The home BYOP section
 * uses the first, but the Packages tab rendered both → duplicated cards.
 *
 * This script (via supabase-js, same creds as the app):
 *   1. keeps the LOWEST-id active custom package,
 *   2. deactivates the rest (soft delete — historical orders keep working),
 *   3. removes their leftover package_slots / package_options rows.
 * The unique partial index that makes duplicates impossible is created by
 * migrate() on the next server boot (see src/db/postgres.ts).
 *
 * Run: npx tsx -r dotenv/config scripts/dedupe-byop.ts
 */
import { supa } from '../src/db/supabase';

async function main() {
  const db = supa();
  const { data: rows, error } = await db
    .from('packages')
    .select('id, name')
    .eq('is_custom', 1)
    .eq('active', 1)
    .order('id', { ascending: true });
  if (error) throw new Error(error.message);
  const list = rows || [];
  console.log(`Active custom packages: ${list.length} → [${list.map((r) => r.id).join(', ')}]`);
  const dupes = list.slice(1).map((r) => Number(r.id));
  if (dupes.length === 0) console.log('No duplicates to remove.');
  for (const id of dupes) {
    // Leftover slot/option rows first (customs carry slot rows from old migrations).
    try {
      const d1 = await db.from('package_slots').delete().eq('package_id', id);
      if (!d1.error && d1.count) console.log(`package ${id}: deleted ${d1.count} package_slots row(s)`);
    } catch (e: any) { console.warn(`package ${id}: package_slots cleanup skipped (${e.message})`); }
    try {
      const d2 = await db.from('package_options').delete().eq('package_id', id);
      if (!d2.error && d2.count) console.log(`package ${id}: deleted ${d2.count} package_options row(s)`);
    } catch (e: any) { console.warn(`package ${id}: package_options cleanup skipped (${e.message})`); }
    const u = await db.from('packages').update({ active: 0 }).eq('id', id);
    if (u.error) throw new Error(`deactivate package ${id} failed: ${u.error.message}`);
    console.log(`package ${id}: deactivated`);
  }
  const { data: after, error: e2 } = await db
    .from('packages')
    .select('id, name')
    .eq('is_custom', 1)
    .eq('active', 1)
    .order('id', { ascending: true });
  if (e2) throw new Error(e2.message);
  console.log(`Active custom packages now: [${(after || []).map((r) => `${r.id} ${r.name}`).join(', ')}]`);
  console.log('Note: the one-active-custom-package DB index is created by migrate() at the next server boot.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e?.message || e); process.exit(1); });
