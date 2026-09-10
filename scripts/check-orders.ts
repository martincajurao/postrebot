import 'dotenv/config';
import { supa } from '../src/db/supabase';

supa().from('orders').select('id,order_number,order_type,address,created_at').order('id', { ascending: false }).limit(5)
  .then((r) => { console.log(JSON.stringify(r.data, null, 1)); process.exit(0); })
  .catch((e) => { console.error(e.message); process.exit(1); });
