/**
 * Fix script: deduplicate triplicated package_slots in Supabase.
 *
 * A migration bug inserted each package slot 3 times (each copy carrying the
 * same single option). This breaks the Messenger customization flow
 * (duplicate "Change #N" quick replies push later slots off the 11-reply
 * limit) and inflates slot lists.
 *
 * For every (package_id, slot_number) group, keep the lowest slot_id and
 * delete the other slots plus their package_options rows.
 *
 * Run: npx tsx src/db/fix-duplicate-slots.ts
 */
import 'dotenv/config';
import { many, run } from './index';

async function main() {
  const groups = await many(
    `SELECT package_id, slot_number, MIN(id) AS keep_id, COUNT(*) AS n
     FROM package_slots GROUP BY package_id, slot_number HAVING COUNT(*) > 1`
  ) as any[];
  console.log(`Found ${groups.length} duplicated slot groups`);

  let slotsDeleted = 0, optsDeleted = 0;
  for (const g of groups) {
    const dupes = await many(
      'SELECT id FROM package_slots WHERE package_id = $1 AND slot_number = $2 AND id > $3',
      [Number(g.package_id), Number(g.slot_number), Number(g.keep_id)]
    ) as any[];
    for (const d of dupes) {
      optsDeleted += await run('DELETE FROM package_options WHERE slot_id = $1', [Number(d.id)]);
      slotsDeleted += await run('DELETE FROM package_slots WHERE id = $1', [Number(d.id)]);
    }
  }
  console.log(`Deleted ${slotsDeleted} duplicate slots and ${optsDeleted} options`);

  // Verify no duplicates remain and every non-custom package has `selections` slots
  const bad = await many(
    `SELECT package_id, slot_number, COUNT(*) AS n FROM package_slots
     GROUP BY package_id, slot_number HAVING COUNT(*) > 1`
  ) as any[];
  if (bad.length) { console.error('STILL DUPLICATED:', JSON.stringify(bad)); process.exit(1); }
  const counts = await many(
    `SELECT p.id, p.name, p.selections, (SELECT COUNT(*) FROM package_slots ps WHERE ps.package_id = p.id) AS slot_count
     FROM packages p WHERE p.active = 1 ORDER BY p.id`
  ) as any[];
  console.log(JSON.stringify(counts, null, 1));
  process.exit(bad.length ? 1 : 0);
}
main();
