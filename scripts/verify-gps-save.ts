/**
 * Live end-to-end verification of the gps.html capture flow:
 *   1. PUT /api/webview/location with the EXACT payload gps.html sends
 *   2. GET /api/webview/location  (what the webview does on revisit)
 *   3. RAW Supabase query on customers — prove the row really exists
 *   4. Cleanup: delete the throwaway test customer
 * Run: npx tsx -r dotenv/config scripts/verify-gps-save.ts
 */
import express from 'express';
import webviewRouter from '../src/api/webview';
import { supa } from '../src/db/supabase';

const app = express();
app.use(express.json());
app.use('/api/webview', webviewRouter);

const server = app.listen(0, async () => {
  const port = (server.address() as any).port;
  const base = 'http://localhost:' + port + '/api/webview';
  const session = 'gps_e2e_verify_' + Date.now();
  // Same coords shape + body keys the gps.html page sends:
  const putBody = { session, lat: 13.6218, lng: 123.1948, address: 'GPS capture page verify (test row)' };

  let ok = 0, bad = 0;
  const check = (name: string, pass: boolean, extra = '') => {
    console.log((pass ? 'PASS: ' : 'FAIL: ') + name + (pass ? '' : ' — ' + extra));
    pass ? ok++ : bad++;
  };

  try {
    // 1. gps.html's PUT
    const put = await fetch(base + '/location', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(putBody),
    });
    const putData = await put.json().catch(() => ({}));
    check('PUT /location (gps.html payload accepted)', put.status === 200 && putData.ok === true,
      'HTTP ' + put.status + ' ' + JSON.stringify(putData));

    // 2. Webview revisit prefill fetch
    const get = await fetch(base + '/location?session=' + encodeURIComponent(session));
    const getData = await get.json();
    check('GET /location (webview prefill reads it back)',
      get.status === 200 && getData && Math.abs(getData.lat - 13.6218) < 1e-6 && Math.abs(getData.lng - 123.1948) < 1e-6,
      JSON.stringify(getData));

    // 3. RAW row in Supabase (bypasses the API entirely)
    const { data: row, error } = await supa()
      .from('customers')
      .select('psid, delivery_lat, delivery_lng, address')
      .eq('psid', session)
      .maybeSingle();
    check('SUPABASE customers row exists with saved coordinates',
      !error && !!row && Number(row.delivery_lat) === 13.6218 && Number(row.delivery_lng) === 123.1948,
      error ? error.message : JSON.stringify(row));
    if (row) console.log('RAW ROW →', JSON.stringify(row, null, 2));

    // 4. Cleanup the throwaway row
    const del = await supa().from('customers').delete().eq('psid', session);
    check('Cleanup (test row deleted)', !del.error, del.error ? del.error.message : '');
    const { data: gone } = await supa().from('customers').select('psid').eq('psid', session).maybeSingle();
    check('Cleanup confirmed (row gone)', gone === null, JSON.stringify(gone));
  } catch (e: any) {
    bad++;
    console.error('FAIL: unexpected error —', e?.message || e);
  }

  console.log(`\nResult: ${ok} passed, ${bad} failed`);
  server.close();
  process.exit(bad === 0 ? 0 : 1);
});
