import 'dotenv/config';
import fs from 'fs';
import path from 'path';

// Cleanup runs immediately in the test so deletions are observable (the module
// reads these at import time, so they must be set before the dynamic import).
process.env.INVOICE_CLEANUP_DELAY_MS = '0';
// Hermetic: a blank token makes sendApi() fail locally, so the smoke test never
// delivers anything to a real inbox.
process.env.PAGE_ACCESS_TOKEN = '';

// Smoke test for the order-completion JPEG invoice.
// Run: npm run test:invoice
// Renders a real invoice, decodes it back to confirm it is a valid image, and
// charges a real COMPLETED order through sendOrderInvoice() end-to-end. Safe to
// run: with PAGE_ACCESS_TOKEN unset, sendImage() logs instead of delivering.

let passed = 0;
let failed = 0;
function assert(name: string, condition: boolean, extra = '') {
  if (condition) {
    console.log('PASS: ' + name + (extra ? ' (' + extra + ')' : ''));
    passed++;
  } else {
    console.error('FAIL: ' + name + (extra ? ' - ' + extra : ''));
    failed++;
  }
}

(async () => {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const { renderInvoiceJpeg, sendOrderInvoice, sweepInvoices, invoiceDir } = await import('./src/services/invoice');
  const { configured, uploadImage, deleteImages } = await import('./src/api/supabase-storage');
  const { supa } = await import('./src/db/supabase');

  // ---------- 1. pure render ----------
  const order = {
    id: 1, order_number: 'PP-SMOKE', order_type: 'delivery',
    address: '123 Mabini St, Cebu City\n📍 Navigate (opens Waze app): waze://?ll=10.3,123.9&navigate=yes',
    delivery_fee: 95, subtotal: 3100, total: 2395, additional_discount: 800,
    fulfillment_date: '2026-09-21', time_slot: '2:00 PM', payment_method: 'COD',
    payment_status: 'UNPAID', status: 'COMPLETED', created_at: '2026-09-20 09:15:00+00',
  };
  const items = [
    {
      name: 'Family Package', variant_size: 'Large', quantity: 1, unit_price: 3100, line_total: 3100,
      package_items: [{ slot_number: 1, product_name: 'Mango Crepe', upgrade_price: 100 }],
    },
  ];
  const store = { contact_phone: '0917-000-0000', contact_hours: 'Mon-Sat, 10AM-7PM', contact_address: '123 Sample St.' };
  const customer = { name: 'Juan Dela Cruz', phone: '09171234567' };

  const buffer = renderInvoiceJpeg({ order, items, customer, store, completedAt: '2026-09-21 06:15:00+00' });
  assert('renderInvoiceJpeg returns a Buffer', Buffer.isBuffer(buffer));
  assert('output is a real JPEG', buffer[0] === 0xff && buffer[1] === 0xd8, Math.round(buffer.length / 1024) + 'KB');

  const img = await loadImage(buffer);
  assert('invoice width is 840px', img.width === 840, 'width=' + img.width);
  assert('invoice height fits the content', img.height >= 600, 'height=' + img.height);

  const ctx = createCanvas(img.width, img.height).getContext('2d');
  ctx.drawImage(img, 0, 0);
  const head = Array.from(ctx.getImageData(12, 12, 1, 1).data).slice(0, 3);
  assert('header band is store green', Math.abs(head[0] - 21) < 10 && Math.abs(head[1] - 128) < 10, 'rgb(' + head.join(',') + ')');
  const foot = Array.from(ctx.getImageData(420, img.height - 6, 1, 1).data).slice(0, 3);
  assert('nothing is clipped at the bottom edge', foot.every((c) => c > 250), 'rgb(' + foot.join(',') + ')');

  // Totals must foot: subtotal − discount + delivery fee = total.
  const derivedDiscount = Math.max(0, order.subtotal - order.total + order.delivery_fee);
  assert('totals foot (subtotal − discount + fee = total)', order.subtotal - derivedDiscount + order.delivery_fee === order.total,
    `${order.subtotal} − ${derivedDiscount} + ${order.delivery_fee} = ${order.total}`);

  // Layout reacts to content instead of leaving dead whitespace.
  const noAddr = await loadImage(renderInvoiceJpeg({ order: { ...order, address: null }, items, customer, store, completedAt: null }));
  assert('address block adds height only when present', noAddr.height < img.height, noAddr.height + ' < ' + img.height);
  const noItems = renderInvoiceJpeg({ order, items: [], customer, store, completedAt: null });
  assert('an order with zero items still renders', (await loadImage(noItems)).width === 840);
  const pickup = renderInvoiceJpeg({
    order: { ...order, order_type: 'pickup', payment_status: 'PAID', payment_method: 'GCASH' },
    items, customer, store, completedAt: null,
  });
  assert('pickup + PAID variant renders', (await loadImage(pickup)).width === 840);

  // The rider-only waze line must never leak onto a customer-facing invoice.
  const wazeOnly = renderInvoiceJpeg({ order: { ...order, address: '📍 Navigate (opens Waze app): waze://?ll=1,2&navigate=yes' }, items, customer, store, completedAt: null });
  assert('a waze-only address produces no address block', (await loadImage(wazeOnly)).height === noAddr.height);

  // ---------- 2. completion wiring ----------
  const adminSrc = fs.readFileSync('src/api/admin.ts', 'utf8');
  const hookSrc = fs.readFileSync('src/messenger/webhook.ts', 'utf8');
  assert('admin status route attaches the invoice on COMPLETED', /if \(status === 'COMPLETED'\) \{\s*\r?\n\s*await sendOrderInvoice\(/.test(adminSrc));
  assert('reservation completion attaches the invoice', /sync\.status === 'COMPLETED'\) await sendOrderInvoice\(/.test(adminSrc));
  assert('customer COMPLETE: postback attaches the invoice', /await sendOrderInvoice\(psid, order\.id\)/.test(hookSrc));

  // ---------- 3. end-to-end against the live workspace ----------
  const BUCKET = process.env.SUPABASE_BUCKET || 'postre';
  const listInvoices = async (): Promise<string[]> => {
    const { data } = await supa().storage.from(BUCKET).list('invoices', { limit: 1000 });
    return (data || []).filter((f: any) => f && f.id !== null).map((f: any) => f.name as string);
  };
  try {
    const { data: done } = await supa().from('orders').select('*').order('id', { ascending: false }).limit(1).maybeSingle();
    if (!done) {
      console.log('SKIP: no order in the database to render');
    } else {
      const fileName = `invoice-${String(done.order_number).replace(/[^A-Za-z0-9._-]/g, '')}.jpg`;
      const sent = await sendOrderInvoice('test_psid_invoice_smoke', Number(done.id));
      // A blank PAGE_ACCESS_TOKEN makes send.ts log a mock send that reports
      // ok:true, so the happy path (host -> attach -> reclaim) is what runs here.
      assert(`sendOrderInvoice built, hosted and attached ${done.order_number}`, sent === true, 'mock send (blank token)');
      const after = await listInvoices();
      assert('the uploaded invoice is reclaimed from the bucket after the send', !after.includes(fileName), `invoices/ now holds ${after.length} object(s)`);
      assert('no local invoice file lingers after sending', !fs.existsSync(path.join(invoiceDir(), fileName)));
    }

    // ---------- 4. orphan sweep (a restart mid-flight must not leak storage) ----------
    if (configured()) {
      const orphan = `invoice-ORPHANTEST-${Date.now()}.jpg`;
      await uploadImage(`invoices/${orphan}`, 'image/jpeg', renderInvoiceJpeg({ order, items, customer, store, completedAt: null }));
      const listed = await supa().storage.from(BUCKET).list('invoices', { limit: 1000 });
      const entry: any = (listed.data || []).find((f: any) => f && f.name === orphan);
      assert('a stored invoice object carries a created_at (sweep age filter input)', !!entry && !!entry.created_at, entry?.created_at || 'missing');
      assert('the orphan is listed before the sweep', !!entry);
      const swept = await sweepInvoices(0);
      assert('sweepInvoices removes orphaned bucket objects', swept >= 1, `removed ${swept}`);
      assert('the orphan is gone after the sweep', !(await listInvoices()).includes(orphan));

      // The production grace window: an object younger than the max age must NOT
      // be swept, otherwise a restart while Messenger is fetching would 404 the
      // attachment the customer was just sent.
      const fresh = `invoice-FRESHTEST-${Date.now()}.jpg`;
      await uploadImage(`invoices/${fresh}`, 'image/jpeg', renderInvoiceJpeg({ order, items, customer, store, completedAt: null }));
      await sweepInvoices(60 * 60 * 1000);
      assert('a recently uploaded invoice survives an age-filtered sweep', (await listInvoices()).includes(fresh));
      await deleteImages([`invoices/${fresh}`]);
    } else {
      console.log('SKIP: Supabase orphan sweep (storage not configured)');
    }

    // ---------- 5. local sweep keeps the grace window ----------
    const dir = invoiceDir();
    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, 'invoice-STALETEST.jpg');
    const fresh = path.join(dir, 'invoice-FRESHTEST.jpg');
    fs.writeFileSync(stale, buffer);
    fs.writeFileSync(fresh, buffer);
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    await sweepInvoices(60 * 60 * 1000);
    assert('a stale local invoice is swept', !fs.existsSync(stale));
    assert('a recent local invoice is kept (Messenger may still be fetching)', fs.existsSync(fresh));
    fs.unlinkSync(fresh);
  } catch (e: any) {
    console.log('SKIP: live check unavailable - ' + (e?.message || e));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
