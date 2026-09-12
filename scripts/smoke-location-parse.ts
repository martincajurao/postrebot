import 'dotenv/config';
import {
  extractLocationFromAttachments,
  extractLocationFromText,
  parseCoordinatesFromUrl,
} from '../src/messenger/webhook';

/**
 * Smoke-test the chat → delivery-pin location parsers.
 *
 * Meta REMOVED native location sharing to Pages, so the only chat GPS path
 * left is a shared LINK: a Google Maps / Waze URL arrives as a `fallback`
 * attachment or plain text, and the bot extracts the coordinates from it.
 * Run: npx tsx scripts/smoke-location-parse.ts
 */
let fail = 0;

async function check(label: string, got: any, want: any) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.error(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label.padEnd(44)} → ${JSON.stringify(got)}`);
}

// ---- extractLocationFromAttachments (async now) --------------------------
const attachCases: [string, any, any][] = [
  ['legacy native location attachment', [
    { type: 'location', payload: { coordinates: { lat: 13.6218, long: 123.1948 }, url: 'https://...' } },
  ], { lat: 13.6218, lng: 123.1948, label: null }],
  ['native attachment latitude/longitude keys', [
    { type: 'location', payload: { coordinates: { latitude: 10.5, longitude: 125.5 }, title: 'My Home' } },
  ], { lat: 10.5, lng: 125.5, label: 'My Home' }],
  ['fallback attachment w/ Maps @lat,lng link', [
    { type: 'fallback', payload: { url: 'https://www.google.com/maps/place/Some+Place/@13.6218,123.1948,17z', title: 'Some Place' } },
  ], { lat: 13.6218, lng: 123.1948, label: 'Some Place' }],
  ['fallback attachment w/ ?q=lat,lng link', [
    { type: 'fallback', payload: { url: 'https://maps.google.com/maps?q=13.62,123.19' } },
  ], { lat: 13.62, lng: 123.19, label: null }],
  ['plain link attachment (Waze ?ll=)', [
    { type: 'fallback', payload: { url: 'https://waze.com/ul?ll=13.6214%2C123.1950&navigate=yes' } },
  ], { lat: 13.6214, lng: 123.195, label: null }],
  ['image attachment ignored', [
    { type: 'image', payload: { url: 'https://.../a.jpg' } },
  ], null],
  ['non-map link ignored', [
    { type: 'fallback', payload: { url: 'https://example.com/page', title: 'Not a map' } },
  ], null],
  ['null island rejected', [
    { type: 'location', payload: { coordinates: { lat: 0, long: 0 } } },
  ], null],
  ['out of range rejected', [
    { type: 'location', payload: { coordinates: { lat: 999, long: 123 } } },
  ], null],
  ['empty attachments', [], null],
];

async function main() {
  for (const [label, input, want] of attachCases) {
    await check(label, await extractLocationFromAttachments(input), want);
  }

// ---- parseCoordinatesFromUrl (pure, offline-deterministic) ---------------
const urlCases: [string, string | null, { lat: number; lng: number } | null][] = [
  ['maps @lat,lng,zoom', 'https://www.google.com/maps/@13.6218,123.1948,17z', { lat: 13.6218, lng: 123.1948 }],
  ['maps place/@lat,lng', 'https://www.google.com/maps/place/Cafe/@13.6218,123.1948,17z', { lat: 13.6218, lng: 123.1948 }],
  ['maps ?q=lat,lng', 'https://maps.google.com/maps?q=13.62,123.19', { lat: 13.62, lng: 123.19 }],
  ['maps ?ll=lat,lng', 'https://www.google.com/maps?ll=13.62,123.19', { lat: 13.62, lng: 123.19 }],
  ['maps ?sll=lat,lng', 'https://www.google.com/maps?sll=13.62,123.19', { lat: 13.62, lng: 123.19 }],
  ['negative coords (west/south)', 'https://www.google.com/maps/@-33.86,-70.95,15z', { lat: -33.86, lng: -70.95 }],
  ['waze ?ll=', 'https://waze.com/ul?ll=13.6214,123.1950', { lat: 13.6214, lng: 123.195 }],
  ['geo: scheme', 'geo:13.6218,123.1948', { lat: 13.6218, lng: 123.1948 }],
  ['non-map url → null', 'https://example.com/page?q=hello,world', null],
  ['maps without coords → null', 'https://www.google.com/maps/place/Naga+City', null],
  ['empty → null', '', null],
];

  for (const [label, input, want] of urlCases) {
    await check(label, parseCoordinatesFromUrl(input as string), want);
  }

  // ---- extractLocationFromText (pasted link in plain text) ------------------
  const textCases: [string, string, any][] = [
    ['pasted maps link in sentence', 'here https://www.google.com/maps/@13.6218,123.1948,17z my house', { lat: 13.6218, lng: 123.1948, label: null }],
    ['pasted waze link', 'https://waze.com/ul?ll=13.6214,123.1950&navigate=yes', { lat: 13.6214, lng: 123.195, label: null }],
    ['plain text no link', 'I live near the church', null],
    ['empty text', '', null],
  ];

  for (const [label, input, want] of textCases) {
    await check(label, await extractLocationFromText(input), want);
  }

  console.log(fail ? `\n${fail} FAILED` : '\nall location-parse cases passed');
  process.exit(fail ? 1 : 0);
}

main();