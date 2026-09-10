import 'dotenv/config';
import { parseBranches, serializeBranches, availableAtBranch, getBranches } from '../src/services/branches';

async function main() {
let fail = 0;
const cases: [string, any, string[]][] = [
  ['JSON string', '["naga","samar"]', ['naga', 'samar']],
  ['comma string with caps', 'Naga, SamAr', ['naga', 'samar']],
  ['array with spaces/caps', [' Naga ', 'samar'], ['naga', 'samar']],
  ['null', null, []],
  ['empty array', [], []],
  ['empty string', '', []],
];
for (const [label, input, want] of cases) {
  const got = parseBranches(input);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.error(`FAIL parse ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  else console.log(`ok   parse ${label.padEnd(24)} → ${JSON.stringify(got)}`);
}

const serOk =
  serializeBranches(['naga']) === '["naga"]' &&
  serializeBranches([]) === null &&
  serializeBranches(null) === null &&
  serializeBranches('naga, samar') === '["naga","samar"]';
console.log(`${serOk ? 'ok  ' : 'FAIL'}  serialize → ${JSON.stringify({ naga: serializeBranches(['naga']), empty: serializeBranches([]), comma: serializeBranches('naga, samar') })}`);
if (!serOk) fail++;

const avChecks: [any, string | undefined, boolean][] = [
  [{ branches: '["samar"]' }, 'naga', false],
  [{ branches: '["samar"]' }, 'samar', true],
  [{ branches: '["naga","samar"]' }, 'naga', true],
  [{}, 'naga', true],                      // universal
  [{ branches: null }, 'samar', true],     // universal
  [{ branches: '[]' }, 'naga', true],      // empty array = universal
  [{ branches: '["samar"]' }, undefined, true], // no branch requested → everything
];
for (const [item, branch, want] of avChecks) {
  const got = availableAtBranch(item, branch);
  if (got !== want) { fail++; console.error(`FAIL availableAtBranch(${JSON.stringify(item)}, ${JSON.stringify(branch)}) = ${got}, want ${want}`); }
  else console.log(`ok   avail ${JSON.stringify(item?.branches ?? null).padEnd(22)} @ ${String(branch).padEnd(7)} → ${got}`);
}

const live = await getBranches();
console.log('live configured branches =', JSON.stringify(live));

if (fail) { console.error(`\n${fail} check(s) FAILED`); process.exit(1); }
console.log('\nAll branch checks passed.');
}
main();