import 'dotenv/config';
import { saveBranchCoords } from '../src/services/branches';

saveBranchCoords({
  naga: { lat: 13.660509, lng: 123.176748 },
  calbayog: { lat: 12.072692, lng: 124.610228 },
}).then(() => { console.log('store coords saved'); process.exit(0); }).catch((e) => { console.error(e.message); process.exit(1); });
