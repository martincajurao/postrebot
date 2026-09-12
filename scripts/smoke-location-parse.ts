import 'dotenv/config';
import { extractLocationFromAttachments } from '../src/messenger/webhook';

/**
 * Smoke-test the Messenger "location" attachment parser — the payload shape
 * Android users produce with "+ → Location → Send" (the only GPS path that
 * works inside Messenger's Android webview). Run: npm run test:branches
 * style → `tsx scripts/smoke-location-parse.ts`.
 */
let fail = 0;

// Real-world Messenger webhook payloads for location shares.
const cases: [string, any, any][] = [
  ['native location attachment', [
    { type: 'location', payload: { coordinates: { lat: 13.6218, long: 123.1948 }, url: 'https://...' } },
  ], { lat: 13.6218, lng: 123.1948, label: null }],
  ['no coordinates key', [
    { type: 'location', payload: { coordinates: { latitude: 10.5, longitude: 125.5 }, title: 'My Home' } },
  ], { lat: 10.5, lng: 125.5, label: 'My Home' }],
  ['fallback attachment with coordinates', [
    { type: 'fallback', payload: { title: 'Some Place', coordinates: { lat: 8.9, long: 126.4 } } },
  ], { lat: 8.9, lng: 126.4, label: 'Some Place' }],
  ['image attachment ignored', [
    { type: 'image', payload: { url: 'https://.../a.jpg' } },
  ], null],
  ['null island rejected', [
    { type: 'location', payload: { coordinates: { lat: 0, long: 0 } } },
  ], null],
  ['out of range rejected', [
    { type: 'location', payload: { coordinates: { lat: 999, long: 123 } } },
  ], null],
  ['empty attachments', [], null],
];

for (const [label, input, want] of cases) {
  const got = extractLocationFromAttachments(input);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.error(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label.padEnd(40)} → ${JSON.stringify(got)}`);
}

console.log(fail ? `\n${fail} FAILED` : '\nall location-parse cases passed');
process.exit(fail ? 1 : 0);