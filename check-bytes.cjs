const fs = require('fs');
const c = fs.readFileSync('src/messenger/webhook.ts', 'utf8');
const line = c.split('\n').find(l => l.includes('Order Now'));
console.log('JSON:', JSON.stringify(line.slice(0, 40)));
console.log('codepoints:', [...line.slice(0, 25)].map(ch => ch.codePointAt(0).toString(16)).join(' '));
