import 'dotenv/config';
import { db, migrate } from './database';

migrate();

// Sample menu data for testing. Idempotent: skips if products already exist.
const productCount = (db.prepare('SELECT COUNT(*) c FROM products').get() as any).c;
if (productCount > 0) {
  console.log('Seed skipped: products already exist.');
  process.exit(0);
}

function cat(name: string): number {
  const row = db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as any;
  return row.id;
}
function product(category: string, name: string, description: string, m: number, l: number): number {
  const out = db.prepare('INSERT INTO products (category_id, name, description) VALUES (?, ?, ?)')
    .run(cat(category), name, description);
  const pid = Number(out.lastInsertRowid);
  const ins = db.prepare('INSERT INTO product_variants (product_id, size, price) VALUES (?, ?, ?)');
  ins.run(pid, 'M', m);
  ins.run(pid, 'L', l);
  return pid;
}

const chickenBbq = product('Chicken', 'Chicken BBQ', 'Char-grilled BBQ chicken', 450, 650);
const friedChicken = product('Chicken', 'Fried Chicken', 'Crispy golden fried chicken', 400, 600);
const porkBbq = product('Pork', 'Pork BBQ', 'Grilled pork skewers', 420, 620);
const menudo = product('Pork', 'Pork Menudo', 'Classic pork menudo', 380, 550);
const caldereta = product('Beef', 'Beef Caldereta', 'Rich tomato beef stew', 550, 780);
const steak = product('Beef', 'Beef Steak', 'Pan-seared beef steak', 600, 850);
const pancit = product('Noodles', 'Pancit', 'Stir-fried noodles', 350, 500);
const palabok = product('Noodles', 'Palabok', 'Rice noodles with shrimp sauce', 420, 620);
const chopsuey = product('Bilao', 'Chopsuey', 'Mixed vegetables', 350, 500);

// Delivery areas (estimated delivery fees - adjust anytime in Admin > Delivery).
const insArea = db.prepare('INSERT INTO delivery_areas (name,fee) VALUES (?, ?)');
insArea.run('Magarao',  50);
insArea.run('Naga City',  100);
insArea.run('Pili',       150);
insArea.run('Other Area',  200);
// Family Package — 4 selections
const fam = db.prepare('INSERT INTO packages (name, description, base_price, selections) VALUES (?, ?, ?, ?)')
  .run('Family Package', 'Choose 4 dishes', 2000, 4);
const famId = Number(fam.lastInsertRowid);
const insSlot = db.prepare('INSERT INTO package_slots (package_id, slot_number) VALUES (?, ?)');
const insOpt = db.prepare('INSERT INTO package_options (slot_id, product_id, upgrade_price, size_upgrade_price, is_default) VALUES (?, ?, ?, ?, ?)');
const buildSlot = (pkgId: number, n: number, opts: [number, number][]) => {
  const sr = insSlot.run(pkgId, n);
  opts.forEach(([pid, up], i) => insOpt.run(Number(sr.lastInsertRowid), pid, up, 100, i === 0 ? 1 : 0));
};
buildSlot(famId, 1, [[chickenBbq, 0], [friedChicken, 0], [caldereta, 150]]);
buildSlot(famId, 2, [[porkBbq, 0], [menudo, 0]]);
buildSlot(famId, 3, [[pancit, 0], [palabok, 0]]);
buildSlot(famId, 4, [[chopsuey, 0]]);
// The Family Package ships as a fixed (ready-to-order) default package.
db.prepare('UPDATE packages SET is_fixed = 1 WHERE id = ?').run(famId);

// Party Package — 5 selections
const party = db.prepare('INSERT INTO packages (name, description, base_price, selections) VALUES (?, ?, ?, ?)')
  .run('Party Package', 'Choose 5 dishes', 2500, 5);
const partyId = Number(party.lastInsertRowid);
buildSlot(partyId, 1, [[chickenBbq, 0], [caldereta, 150], [steak, 250]]);
buildSlot(partyId, 2, [[porkBbq, 0], [menudo, 0]]);
buildSlot(partyId, 3, [[pancit, 0], [palabok, 0]]);
buildSlot(partyId, 4, [[chopsuey, 0]]);
buildSlot(partyId, 5, [[friedChicken, 0]]);

console.log('Seed complete: sample menu, packages, delivery areas created.');
