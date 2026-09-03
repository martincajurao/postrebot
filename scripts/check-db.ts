import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/postre.db');

// Get all tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
console.log('Tables:', tables.map((t: any) => t.name).join(', '));

// Count rows in each table
for (const t of tables) {
  const count = db.prepare(`SELECT COUNT(*) as c FROM ${t.name}`).get() as any;
  console.log(`  ${t.name}: ${count.c} rows`);
}

// Show sample data
console.log('\n--- Categories ---');
console.log(db.prepare('SELECT * FROM categories LIMIT 5').all());

console.log('\n--- Products ---');
console.log(db.prepare('SELECT * FROM products LIMIT 5').all());

console.log('\n--- Packages ---');
console.log(db.prepare('SELECT * FROM packages LIMIT 5').all());

console.log('\n--- Package Slots ---');
console.log(db.prepare('SELECT * FROM package_slots LIMIT 5').all());

console.log('\n--- Package Options ---');
console.log(db.prepare('SELECT * FROM package_options LIMIT 5').all());

db.close();
