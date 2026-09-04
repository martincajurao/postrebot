require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`DELETE FROM food_packs WHERE name = $1`, ['Test Pack A']);
  const r = await c.query(`SELECT count(*)::int AS n FROM food_packs`);
  console.log('remaining packs:', r.rows[0].n);
  await c.end();
})().catch(e => { console.error(e); process.exit(1); });
