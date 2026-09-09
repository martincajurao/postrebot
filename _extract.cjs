const fs = require('fs');
const appPath = 'c:\\Users\\Mizeri Jiwu\\Desktop\\MEssenger-bot\\public\\webview\\app.js';
const htmlPath = 'c:\\Users\\Mizeri Jiwu\\Desktop\\MEssenger-bot\\public\\webview\\index.html';
const c = Buffer.from(fs.readFileSync(appPath));

function slice(c, start, len) {
  return c.slice(Math.max(0, start), Math.max(0, start) + len).toString('utf8');
}

// --- useCurrentLocation region ---
const i1 = c.indexOf('function useCurrentLocation');
const d1 = slice(c, Math.max(0, i1 - 200), Math.min(8000, c.length - Math.max(0,i1-200)));
fs.writeFileSync('c:\\Users\\Mizeri Jiwu\\Desktop\\MEssenger-bot\\extract_map.cjs',
  '/* useCurrentLocation + helpers before it */\n' + d1 + '\n/* END */\n');
console.log('extract_map len=' + d1.length);

// --- showLocationGate / saveLocation / confirmLocation ---
const i2 = c.indexOf('function saveLocation');
const i3 = c.indexOf('function showLocationGate');
const i4 = c.indexOf('function confirmLocation');
const startJ = Math.min(i2, i3, i4);
const d2 = slice(c, Math.max(0, startJ - 150), Math.min(9000, c.length - Math.max(0,startJ-150)));
fs.writeFileSync('c:\\Users\\Mizeri Jiwu\\Desktop\\MEssenger-bot\\extract_gatejs.cjs',
  '/* init/helper/saveLocation area */\n' + d2 + '\n/* END */\n');
console.log('extract_gatejs len=' + d2.length);

// --- HTML gate markup ---
const hc = fs.readFileSync(htmlPath);
const hi = hc.indexOf('id="location-gate"');
const hend = hc.indexOf('</div>', hi + 200);
const gateHtml = hc.slice(hi, hend + 6).toString('utf8');
fs.writeFileSync('c:\\Users\\Mizeri Jiwu\\Desktop\\MEssenger-bot\\extract_gatehtml.cjs',
  '/* location-gate HTML markup */\n' + gateHtml + '\n/* END */\n');
console.log('gate HTML len=' + gateHtml.length);

// --- init tail (where showLocationGate is called) ---
const i5 = c.indexOf('function init(');
const i6 = c.indexOf('showLocationGate', i5);
const d3 = slice(c, Math.max(0, i5 - 100), Math.min(4000, c.length - Math.max(0,i5-100)));
fs.writeFileSync('c:\\Users\\Mizeri Jiwu\\Desktop\\MEssenger-bot\\extract_init.cjs',
  '/* init region */\n' + d3 + '\n/* END */\n');
console.log('extract_init len=' + d3.length);

// --- getSavedLocation / saveLocation existing ---
const i7 = c.indexOf('function getSavedLocation');
const d4 = slice(c, Math.max(0, i7 - 80), Math.min(2500, c.length - Math.max(0,i7-80)));
fs.writeFileSync('c:\\Users\\Mizeri Jiwu\\Desktop\\MEssenger-bot\\extract_save.cjs',
  '/* getSavedLocation/saveLocation region */\n' + d4 + '\n/* END */\n');
console.log('extract_save len=' + d4.length);
