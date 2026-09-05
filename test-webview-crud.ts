import express from 'express';
import webviewRouter from './src/api/webview';

const app = express();
app.use(express.json());
app.use('/api/webview', webviewRouter);

const server = app.listen(0, async () => {
  const port = (server.address() as any).port;
  const base = 'http://localhost:' + port + '/api/webview';
  const session = 'test_session_' + Date.now();

  async function req(path: string, opts: any = {}) {
    const res = await fetch(base + path, {
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    return { status: res.status, data: await res.json() };
  }

  let passed = 0;
  let failed = 0;
  function assert(name: string, condition: boolean, extra = '') {
    if (condition) {
      console.log('PASS: ' + name);
      passed++;
    } else {
      console.error('FAIL: ' + name + (extra ? ' - ' + extra : ''));
      failed++;
    }
  }

  try {
    // 1. Categories
    const cats = await req('/categories');
    assert('GET /categories', cats.status === 200 && Array.isArray(cats.data) && cats.data.length > 0);
    const catId = cats.data[0].id;
    const singleCat = await req('/categories/' + catId);
    assert('GET /categories/:id', singleCat.status === 200 && singleCat.data.id === catId);

    // 2. Products
    const prods = await req('/products');
    assert('GET /products', prods.status === 200 && Array.isArray(prods.data) && prods.data.length > 0);
    assert('GET /products has variants', Array.isArray(prods.data[0].variants));
    const prodId = prods.data[0].id;
    const singleProd = await req('/products/' + prodId);
    assert('GET /products/:id', singleProd.status === 200 && singleProd.data.id === prodId && Array.isArray(singleProd.data.variants));

    // 3. Packages
    const pkgs = await req('/packages');
    assert('GET /packages', pkgs.status === 200 && Array.isArray(pkgs.data) && pkgs.data.length > 0);
    const pkgWithSlots = pkgs.data.find((p: any) => p.slots && p.slots.some((s: any) => s.options && s.options.length > 0));
    if (pkgWithSlots) {
      const slot = pkgWithSlots.slots.find((s: any) => s.options && s.options.length > 0);
      assert('GET /packages slot has options', Array.isArray(slot.options) && slot.options.length > 0);
      assert('GET /packages slot option has name', typeof slot.options[0].name === 'string');
    }
    const singlePkg = await req('/packages/' + pkgs.data[0].id);
    assert('GET /packages/:id', singlePkg.status === 200 && singlePkg.data.id === pkgs.data[0].id);

    // 4. Food Packs
    const fps = await req('/food-packs');
    assert('GET /food-packs', fps.status === 200 && Array.isArray(fps.data));

    // 5. Cart CRUD
    // Read empty
    const cartEmpty = await req('/cart?session=' + session);
    assert('GET /cart (empty)', cartEmpty.status === 200 && cartEmpty.data.items.length === 0);

    // Create (Add) item via POST /cart/add
    const add1 = await req('/cart/add', {
      method: 'POST',
      body: JSON.stringify({ session, product_id: prodId, variant_size: prods.data[0].variants[0]?.size || 'Regular', quantity: 2 }),
    });
    assert('POST /cart/add (product)', add1.status === 200 && add1.data.ok && add1.data.items.length === 1);
    const item1Id = add1.data.items[0].id;

    // Create (Add) second product via REST POST /cart with valid variant
    const p2 = prods.data[1] || prods.data[0];
    const add2 = await req('/cart', {
      method: 'POST',
      body: JSON.stringify({
        session,
        product_id: p2.id,
        variant_size: p2.variants[0]?.size || 'Regular',
        quantity: 1,
      }),
    });
    assert('POST /cart (REST add)', add2.status === 200 && add2.data.ok && add2.data.items?.length === 2);
    const item2Id = add2.data.items[1].id;

    // Read Cart via GET /cart
    const cartFull = await req('/cart?session=' + session);
    assert('GET /cart (read items)', cartFull.data.items.length === 2 && cartFull.data.totals.subtotal > 0);

    // Update quantity via REST PUT /cart/:id
    const update1 = await req('/cart/' + item1Id, {
      method: 'PUT',
      body: JSON.stringify({ session, quantity: 5 }),
    });
    assert('PUT /cart/:id (REST update)', update1.status === 200 && update1.data.ok);
    const updatedItem = update1.data.items.find((i: any) => i.id === item1Id);
    assert('Quantity updated to 5', updatedItem?.quantity === 5);

    // Update quantity via POST /cart/update-quantity
    const update2 = await req('/cart/update-quantity', {
      method: 'POST',
      body: JSON.stringify({ session, item_id: item1Id, quantity: 3 }),
    });
    assert('POST /cart/update-quantity', update2.status === 200 && update2.data.ok);

    // Delete single item via REST DELETE /cart/:id
    const del1 = await req('/cart/' + item2Id + '?session=' + session, { method: 'DELETE' });
    assert('DELETE /cart/:id (REST delete)', del1.status === 200 && del1.data.ok && del1.data.items.length === 1);

    // Delete single item via POST /cart/remove
    const del2 = await req('/cart/remove', {
      method: 'POST',
      body: JSON.stringify({ session, item_id: item1Id }),
    });
    assert('POST /cart/remove', del2.status === 200 && del2.data.ok && del2.data.items.length === 0);

    // Add another item and test DELETE /cart (Clear cart)
    await req('/cart/add', {
      method: 'POST',
      body: JSON.stringify({ session, product_id: prodId, variant_size: prods.data[0].variants[0]?.size || 'Regular', quantity: 1 }),
    });
    const clearRes = await req('/cart?session=' + session, { method: 'DELETE' });
    assert('DELETE /cart (REST clear)', clearRes.status === 200 && clearRes.data.ok && clearRes.data.items.length === 0);

    // 6. Checkout & Orders CRUD
    // Add item for checkout
    await req('/cart/add', {
      method: 'POST',
      body: JSON.stringify({ session, product_id: prodId, variant_size: prods.data[0].variants[0]?.size || 'Regular', quantity: 1 }),
    });

    const checkoutRes = await req('/checkout', {
      method: 'POST',
      body: JSON.stringify({
        session,
        order_type: 'pickup',
        phone: '09123456789',
        name: 'Test Customer',
        fulfillment_date: '2026-10-15',
        time_slot: '10:00 AM - 12:00 PM',
        payment_method: 'cod',
      }),
    });
    assert('POST /checkout', checkoutRes.status === 200 && checkoutRes.data.ok && checkoutRes.data.order_id);
    const orderId = checkoutRes.data.order_id;

    // 6b. Checkout with CLIENT-SIDE cart items (webview local-cart flow).
    // Items carry only ids/quantities — the server re-prices every line.
    const pkgList = (await req('/packages')).data;
    const fixedPkg = Array.isArray(pkgList)
      ? pkgList.find((p: any) => Array.isArray(p.slots) && p.slots.some((s: any) => Array.isArray(s.options) && s.options.length > 0))
      : null;
    const fpsAll = await req('/food-packs');
    const fp = Array.isArray(fpsAll.data) && fpsAll.data.length > 0 ? fpsAll.data[0] : null;

    const clientItems: any[] = [
      { product_id: prodId, variant_size: prods.data[0].variants[0]?.size || 'Regular', quantity: 2 },
    ];
    if (fixedPkg) {
      const slot_choices = fixedPkg.slots
        .filter((s: any) => Array.isArray(s.options) && s.options.length > 0)
        .map((s: any) => ({ slot_number: s.slot_number, product_id: s.options[0].product_id }));
      clientItems.push({ package_id: fixedPkg.id, variant_size: 'M', quantity: 1, slot_choices });
    }
    if (fp) clientItems.push({ food_pack_id: fp.id, quantity: 1 });

    const coRes = await req('/checkout', {
      method: 'POST',
      body: JSON.stringify({
        session,
        order_type: 'delivery',
        address: '123 Test St.',
        phone: '09123456789',
        name: 'Test Customer',
        fulfillment_date: '2026-10-15',
        time_slot: '10:00 AM - 12:00 PM',
        payment_method: 'gcash',
        items: clientItems,
      }),
    });
    assert('POST /checkout (client items)', coRes.status === 200 && coRes.data.ok && coRes.data.order_id,
      coRes.data && coRes.data.error ? String(coRes.data.error) : '');
    if (coRes.data && coRes.data.ok) {
      const detail = await req('/orders/' + coRes.data.order_id);
      assert('Client-item order has all lines', Array.isArray(detail.data.items) && detail.data.items.length === clientItems.length,
        'got ' + (detail.data.items || []).length + ' expected ' + clientItems.length);
      assert('Client-item order total > 0', Number(detail.data.total) > 0);
      assert('Client-item order priced server-side', Number(detail.data.subtotal) > 0);
      await req('/orders/' + coRes.data.order_id + '?session=' + session, { method: 'DELETE' });
    }

    // Read Orders
    const ordersRes = await req('/orders?session=' + session);
    assert('GET /orders', ordersRes.status === 200 && Array.isArray(ordersRes.data) && ordersRes.data.some((o: any) => o.id === orderId));

    // Read single Order
    const singleOrder = await req('/orders/' + orderId);
    assert('GET /orders/:id', singleOrder.status === 200 && singleOrder.data.id === orderId && Array.isArray(singleOrder.data.items));

    // Cancel Order via DELETE /orders/:id
    const cancelRes = await req('/orders/' + orderId + '?session=' + session, { method: 'DELETE' });
    assert('DELETE /orders/:id (cancel)', cancelRes.status === 200 && cancelRes.data.ok);

    const cancelledOrder = await req('/orders/' + orderId);
    assert('Order is now CANCELLED', cancelledOrder.data.status === 'CANCELLED');

    // 7. Config, Enabled, Slots
    const cfg = await req('/config');
    assert('GET /config', cfg.status === 200 && cfg.data.payment && cfg.data.contact);

    const enabled = await req('/enabled');
    assert('GET /enabled', enabled.status === 200 && typeof enabled.data.enabled === 'boolean');

    const slots = await req('/slots?date=2026-10-15');
    assert('GET /slots', slots.status === 200 && Array.isArray(slots.data.slots));

    console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
  } catch (err) {
    console.error('Test crashed:', err);
    failed++;
  } finally {
    server.close();
    process.exit(failed > 0 ? 1 : 0);
  }
});
