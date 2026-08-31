const fs = require('fs');
const p = 'src/messenger/webhook.ts';
let c = fs.readFileSync(p, 'utf8');
if (c.includes('\u00f0\u0178') || c.includes('\u00e2\u20ac')) {
  c = Buffer.from(c, 'latin1').toString('utf8');
  fs.writeFileSync(p, c, 'utf8');
  console.log('encoding repaired');
} else { console.log('already clean'); }
