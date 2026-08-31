const fs = require('fs');
const p = 'src/messenger/webhook.ts';
let c = fs.readFileSync(p, 'utf8');

// 1) absolute URL helper + BASE_URL
c = c.replace(
  "const r = Router();",
  `const r = Router();

const BASE_URL = process.env.BASE_URL || '';
/** Messenger requires absolute https URLs for images. */
function absUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (/^https?:\\/\\//.test(url)) return url;
  if (!BASE_URL) return undefined; // no public URL configured -> skip image
  return BASE_URL.replace(/\\/$/, '') + url;
}`
);

// 2) use absUrl for carousel images
c = c.replace('image_url: p.photo_url,', 'image_url: absUrl(p.photo_url),');
c = c.replace('image_url: p.photo_url,', 'image_url: absUrl(p.photo_url),');
c = c.replace('image_url: p.photo_url,', 'image_url: absUrl(p.photo_url),');
// catch any remaining variants
c = c.replace(/image_url:\s*p\.photo_url/g, 'image_url: absUrl(p.photo_url)');

// 3) strip emojis from button/quick-reply titles (keep them in text bodies)
const strip = (s) => s;
const replacements = [
  ["title: '🛒 Order Now'", "title: 'Order Now'"],
  ["title: '🔥 Packages'", "title: 'Packages'"],
  ["title: '📋 Menu'", "title: 'Menu'"],
  ["title: '📅 Reservation'", "title: 'Reservation'"],
  ["title: '🛒 My Cart'", "title: 'My Cart'"],
  ["title: '☎️ Contact Us'", "title: 'Contact Us'"],
  ["title: '✅ Checkout'", "title: 'Checkout'"],
  ["title: '➕ Add More'", "title: 'Add More'"],
  ["title: '🗑 Remove Item'", "title: 'Remove Item'"],
  ["title: '⬅ Back'", "title: 'Back'"],
  ["title: '⬅ Back to menu'", "title: 'Back to Menu'"],
  ["title: '⬅ Categories'", "title: 'Categories'"],
  ["title: '🛒 View Cart'", "title: 'View Cart'"],
  ["title: '➡ Size & Add'", "title: 'Size & Add'"],
  ["title: 'M (Included)'", "title: 'M - Included'"],
  ["title: 'L (+upgrade)'", "title: 'L + Upgrade'"],
  ["title: '🚚 Delivery'", "title: 'Delivery'"],
  ["title: '🏬 Pickup'", "title: 'Pickup'"],
  ["title: '✅ Place Order'", "title: 'Place Order'"],
  ["title: '❌ Cancel'", "title: 'Cancel'"],
  ["title: '⏭ No schedule needed'", "title: 'No schedule needed'"],
  ["title: `Change #${s.slot_number}`", "title: `Change #${s.slot_number}`"],
];
for (const [a, b] of replacements) c = c.split(a).join(b);
// titles built from data: strip leading emojis in category/product names is admin's choice; nothing to do

fs.writeFileSync(p, c);
console.log('patched webhook.ts');
