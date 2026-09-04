// Unit test for parseDateInput (exported from dist/messenger/webhook.js)
const { parseDateInput } = require('./dist/messenger/webhook');
const envYear = new Date().getFullYear();

const cases = [
  // [input, expected date or null]
  ['2026-09-25', '2026-09-25'],
  ['2026-9-5', '2026-09-05'],
  ['09/25', envYear + '-09-25'],
  ['9-25', envYear + '-09-25'],
  ['09/25/2026', '2026-09-25'],
  ['9/25/26', '2026-09-25'],
  ['Sep 25', envYear + '-09-25'],
  ['september 25', envYear + '-09-25'],
  ['september 25, 2026', '2026-09-25'],
  ['25 sept', envYear + '-09-25'],
  ['25th September 2026', '2026-09-25'],
  ['25/09', envYear + '-09-25'],           // day-first auto-detected
  ['today', iso(new Date())],
  ['tomorrow', iso(new Date(Date.now() + 86400000))],
  ['2026-02-30', null],                     // Feb 30 invalid
  ['13/13', null],                          // nonsense -> invalid (both >12)
  ['tomato', null],
  ['', null],
];
function iso(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

let pass = 0, fail = 0;
for (const [input, expected] of cases) {
  const r = parseDateInput(input);
  const got = r.ok ? r.date : null;
  const ok = got === expected;
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS' : 'FAIL') + '  "' + input + '" -> ' + (got || '(invalid)') + (ok ? '' : '  (expected ' + expected + ')'));
}
console.log('\nparseDateInput: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);