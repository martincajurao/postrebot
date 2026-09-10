import 'dotenv/config';
import { createOrderFromCart } from '../src/services/orders';
import { supa } from '../src/db/supabase';

(async () => {
  const r = await createOrderFromCart('wv_testcoords', {
    customer_id: 1,
    order_type: 'delivery',
    address: 'Test St. 123',
    phone: '09170000001',
    delivery_lat: 12.105,
    delivery_lng: 124.62,
  }, [
    { product_id: 103, quantity: 1, variant_size: 'M' },
  ]);
  const { data } = await supa()
    .from('orders')
    .select('order_number, address, delivery_fee, total')
    .eq('id', r.orderId)
    .maybeSingle();
  console.log(JSON.stringify(data, null, 2));
  await supa().from('order_items').delete().eq('order_id', r.orderId);
  await supa().from('orders').delete().eq('id', r.orderId);
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});

