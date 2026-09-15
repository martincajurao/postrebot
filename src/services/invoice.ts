import fs from 'fs';
import path from 'path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import type { SKRSContext2D } from '@napi-rs/canvas';
import { sendImage, customerAddress } from '../messenger/send';
import { uploadImage, deleteImages, bucket, configured as supabaseConfigured } from '../api/supabase-storage';
import { getOrderById, getOrderItems } from './orders';
import { getStoreInfo } from './store-info';
import { supa } from '../db/supabase';

// ---------- Order invoice (JPEG) ----------
// When an order is COMPLETED the bot attaches a rendered JPEG invoice to the
// customer's Messenger thread. The image is drawn server-side with
// @napi-rs/canvas (prebuilt binaries — no native compilation needed), uploaded
// to the Supabase Storage bucket (the same one that hosts product photos) and
// sent through sendImage(), which requires a PUBLIC url Messenger can fetch.
//
// The layout is built as a list of draw ops measured on a scratch context, so
// the real canvas is created ONCE at the exact height the content needs — an
// invoice is never clipped and never carries dead whitespace.
//
// Only glyphs that ship with the base fonts are used (₱ • · — ×). Emoji are
// deliberately avoided: a slim Linux container that lacks an emoji font would
// otherwise render them as blank boxes in a customer-facing receipt.

const W = 840;
const MARGIN = 48;
const CONTENT_W = W - MARGIN * 2;
const HEADER_H = 132;
const ACCENT = '#15803d'; // store green
const ACCENT_DARK = '#0f5c2c';
const ACCENT_SOFT = '#f0fdf4';
const ZEBRA = '#fafafa';
const INK = '#111827';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const WARN = '#b45309';
const FONT_STACK = '"Segoe UI", "Helvetica Neue", Arial, "DejaVu Sans", "Noto Sans", sans-serif';

const peso = (n: number | null | undefined): string =>
  '₱' + Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 0 });

function setFont(ctx: SKRSContext2D, size: number, weight: 'normal' | 'bold' = 'normal'): void {
  ctx.font = `${weight} ${size}px ${FONT_STACK}`;
}

/** Truncate with an ellipsis so a line never overflows its column. */
function fitText(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
  return t.trimEnd() + '…';
}

/** Word-wrap an address into lines that fit the column. */
function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = String(text).split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (ctx.measureText(next).width > maxWidth && cur) {
      out.push(cur);
      cur = w;
      if (out.length === maxLines) break;
    } else {
      cur = next;
    }
  }
  if (cur && out.length < maxLines) out.push(cur);
  // Last line gets the ellipsis if anything was cut.
  const consumed = out.join(' ').length;
  if (consumed < String(text).trim().length && out.length) {
    out[out.length - 1] = fitText(ctx, out[out.length - 1], maxWidth);
  }
  return out;
}

// ---------- font bootstrap ----------
let fontsReady = false;

/** @napi-rs/canvas uses the OS font manager. Slim Linux containers (Render)
 *  sometimes ship only DejaVu, so register it explicitly when present —
 *  otherwise every glyph (₱ included) would come out as an empty box. */
function ensureFonts(): void {
  if (fontsReady) return;
  fontsReady = true;
  try {
    const dirs = ['/usr/share/fonts/truetype/dejavu', '/usr/share/fonts/dejavu', '/usr/share/fonts/TTF'];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const n = GlobalFonts.loadFontsFromDir(dir);
      console.log(`[invoice] registered ${n} font(s) from ${dir}`);
      break;
    }
    console.log(`[invoice] font families available: ${GlobalFonts.families.length}`);
  } catch (e: any) {
    console.warn('[invoice] font bootstrap failed (using system defaults):', e?.message || e);
  }
}

// ---------- small drawing helpers ----------
/** Rounded-rectangle path — hand-rolled so it works on every canvas version. */
function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.arcTo(x + w, y, x + w, y + rad, rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.arcTo(x + w, y + h, x + w - rad, y + h, rad);
  ctx.lineTo(x + rad, y + h);
  ctx.arcTo(x, y + h, x, y + h - rad, rad);
  ctx.lineTo(x, y + rad);
  ctx.arcTo(x, y, x + rad, y, rad);
  ctx.closePath();
}

/** Human date from a DB text timestamp (`now()::text`); falls back to the raw
 *  value if it is not parseable so we never print "Invalid Date". */
function longDate(value?: string | null): string {
  if (!value) return '—';
  const raw = String(value).trim();
  // Postgres `now()::text` reads like `2026-09-15 13:13:00.114422+00`. JS only
  // accepts a padded offset (`+00:00`), so normalise both forms before parsing —
  // otherwise every stored timestamp falls back to its raw, unformatted text.
  const iso = raw
    .replace(' ', 'T')
    .replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
    .replace(/([+-]\d{2})$/, '$1:00');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return raw;
  try {
    return d.toLocaleString('en-PH', {
      timeZone: 'Asia/Manila',
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** Date-only formatter for fulfillment_date (stored as `YYYY-MM-DD`). Parsed by
 *  hand so a bare date never shifts a day across timezones, and never gains a
 *  bogus time of its own. Anything already human-readable passes through. */
function shortDate(value?: string | null): string {
  const raw = String(value || '').trim();
  if (!raw) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return raw;
  // Noon UTC = same calendar day anywhere in the Philippines.
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 4, 0, 0));
  try {
    return d.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return raw;
  }
}

export interface InvoiceInput {
  order: any;
  items: any[];
  customer: { name?: string | null; phone?: string | null };
  store: { contact_phone?: string; contact_email?: string; contact_address?: string; contact_hours?: string };
  completedAt?: string | null;
}

type DrawOp = (ctx: SKRSContext2D) => void;

/** Render a completed order as a branded JPEG invoice buffer (pure render, no I/O). */
export function renderInvoiceJpeg(input: InvoiceInput): Buffer {
  ensureFonts();
  const { order, items, customer, store } = input;
  const measure = createCanvas(8, 8).getContext('2d');
  const ops: DrawOp[] = [];

  const text = (
    value: any, x: number, top: number, size: number, weight: 'normal' | 'bold', color: string, align: 'left' | 'right' = 'left',
  ) => {
    const label = String(value ?? '');
    ops.push((ctx) => {
      setFont(ctx, size, weight);
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.textBaseline = 'top';
      ctx.fillText(label, x, top);
      ctx.textAlign = 'left';
    });
  };
  const fill = (x: number, y: number, w: number, h: number, color: string, radius = 0) => ops.push((ctx) => {
    ctx.fillStyle = color;
    if (radius > 0) { roundRect(ctx, x, y, w, h, radius); ctx.fill(); } else ctx.fillRect(x, y, w, h);
  });
  const outline = (x: number, y: number, w: number, h: number, color = LINE, radius = 12) => ops.push((ctx) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, radius);
    ctx.stroke();
  });
  const rule = (x: number, y: number, w: number, color = LINE) => ops.push((ctx) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y + 0.5);
    ctx.lineTo(x + w, y + 0.5);
    ctx.stroke();
  });

  // ----- order facts -----
  const isDelivery = String(order.order_type || '').toLowerCase() === 'delivery';
  const rawDate = String(order.fulfillment_date || '').trim();
  const slot = String(order.time_slot || '').trim();
  const isAsap = !rawDate || rawDate.toUpperCase() === 'ASAP';
  const schedule = isAsap ? 'ASAP' : (slot && slot.toUpperCase() !== 'ASAP' ? `${shortDate(rawDate)} at ${slot}` : shortDate(rawDate));
  const method = String(order.payment_method || 'COD').toUpperCase();
  const payStatus = String(order.payment_status || 'UNPAID').toUpperCase();

  // ----- header band -----
  fill(0, 0, W, HEADER_H, ACCENT);
  fill(0, HEADER_H - 6, W, 6, ACCENT_DARK);
  text('POSTRE FOOD PRODUCTS', MARGIN, 30, 26, 'bold', '#ffffff');
  text("Crepe de Mango's", MARGIN, 64, 15, 'normal', '#dcfce7');
  text([store.contact_phone, store.contact_hours].filter(Boolean).join('   ·   '), MARGIN, 92, 12, 'normal', '#bbf7d0');
  text('SALES INVOICE', W - MARGIN, 34, 20, 'bold', '#ffffff', 'right');
  text(`No. ${order.order_number || '-'}`, W - MARGIN, 64, 14, 'bold', '#dcfce7', 'right');
  text(`Issued ${longDate(input.completedAt)}`, W - MARGIN, 92, 12, 'normal', '#bbf7d0', 'right');

  // ----- status chips -----
  let y = HEADER_H + 30;
  const chip = (label: string, x: number, bg: string, fg: string): number => {
    setFont(measure, 12.5, 'bold');
    const w = Math.ceil(measure.measureText(label).width) + 28;
    fill(x, y, w, 27, bg, 14);
    text(label, x + 14, y + 7, 12.5, 'bold', fg);
    return x + w + 10;
  };
  let chipX = chip(`• ${String(order.status || 'COMPLETED').toUpperCase()}`, MARGIN, ACCENT, '#ffffff');
  const payLabel = payStatus === 'PAID' ? '• PAID' : payStatus === 'PAYMENT_SUBMITTED' ? '• PAYMENT FOR REVIEW' : '• UNPAID';
  chip(payLabel, chipX, payStatus === 'PAID' ? ACCENT_SOFT : '#fef3c7', payStatus === 'PAID' ? ACCENT : WARN);
  text(`Order placed ${longDate(order.created_at)}`, W - MARGIN, y + 8, 12, 'normal', MUTED, 'right');
  y += 46;

  // ----- customer / order cards -----
  const gap = 20;
  const colW = (CONTENT_W - gap) / 2;
  const cardH = 104;
  const rx = MARGIN + colW + gap + 18;
  fill(MARGIN, y, colW, cardH, '#f9fafb', 12);
  outline(MARGIN, y, colW, cardH, LINE, 12);
  fill(MARGIN + colW + gap, y, colW, cardH, '#f9fafb', 12);
  outline(MARGIN + colW + gap, y, colW, cardH, LINE, 12);
  text('BILLED TO', MARGIN + 18, y + 15, 11.5, 'bold', MUTED);
  text(customer.name || 'Messenger customer', MARGIN + 18, y + 36, 17, 'bold', INK);
  text(`Contact #: ${customer.phone || '—'}`, MARGIN + 18, y + 63, 12.5, 'normal', MUTED);
  text(`Order #: ${order.order_number || '—'}`, MARGIN + 18, y + 82, 12.5, 'normal', MUTED);
  text('ORDER DETAILS', rx, y + 15, 11.5, 'bold', MUTED);
  text(isDelivery ? 'Delivery' : 'Pickup', rx, y + 36, 17, 'bold', INK);
  text(`Schedule: ${schedule}`, rx, y + 63, 12.5, 'normal', MUTED);
  text(`Payment: ${method}`, rx, y + 82, 12.5, 'normal', MUTED);
  y += cardH;

  // ----- address (rider-only waze lines already stripped) -----
  const addressText = customerAddress(order.address).replace(/\n+/g, ', ').trim();
  if (addressText) {
    y += 16;
    setFont(measure, 13, 'normal');
    const lines = wrapText(measure, addressText, CONTENT_W - 36, 3);
    const addrH = 32 + lines.length * 18 + 18;
    fill(MARGIN, y, CONTENT_W, addrH, '#ffffff', 12);
    outline(MARGIN, y, CONTENT_W, addrH, LINE, 12);
    text(isDelivery ? 'DELIVER TO' : 'PICKUP AT', MARGIN + 18, y + 13, 11.5, 'bold', MUTED);
    lines.forEach((l, i) => text(l, MARGIN + 18, y + 32 + i * 18, 13, 'normal', INK));
    y += addrH;
  }

  // ----- items table -----
  y += 24;
  const colAmountR = MARGIN + CONTENT_W - 18;
  const colUnitR = colAmountR - 120;
  const colQtyR = colUnitR - 110;
  const itemX = MARGIN + 18;
  const itemMax = colQtyR - 160 - itemX;
  const headH = 34;
  fill(MARGIN, y, CONTENT_W, headH, '#f3f4f6', 10);
  text('ITEM', itemX, y + 11, 11.5, 'bold', MUTED);
  text('QTY', colQtyR, y + 11, 11.5, 'bold', MUTED, 'right');
  text('UNIT PRICE', colUnitR, y + 11, 11.5, 'bold', MUTED, 'right');
  text('AMOUNT', colAmountR, y + 11, 11.5, 'bold', MUTED, 'right');
  y += headH;

  items.forEach((item: any, idx: number) => {
    setFont(measure, 14, 'bold');
    const nameLines = wrapText(measure, item.name || 'Item', itemMax, 2);
    setFont(measure, 12, 'normal');
    const subLines: string[] = [];
    if (item.variant_size) subLines.push(`Size: ${item.variant_size}`);
    for (const p of (item.package_items || []).filter(Boolean)) {
      subLines.push(...wrapText(measure, `• Slot ${p.slot_number}: ${p.product_name}${Number(p.upgrade_price) > 0 ? ` (+${peso(p.upgrade_price)})` : ''}`, itemMax, 2));
    }
    const rowH = 18 + nameLines.length * 18 + subLines.length * 16 + 14;
    if (idx % 2 === 1) fill(MARGIN, y, CONTENT_W, rowH, ZEBRA);
    let ty = y + 14;
    nameLines.forEach((l) => { text(l, itemX, ty, 14, 'bold', INK); ty += 18; });
    subLines.forEach((l) => { text(l, itemX, ty, 12, 'normal', MUTED); ty += 16; });
    text(String(Number(item.quantity) || 1), colQtyR, y + 14, 13.5, 'normal', INK, 'right');
    text(peso(item.unit_price), colUnitR, y + 14, 13.5, 'normal', INK, 'right');
    text(peso(item.line_total), colAmountR, y + 14, 13.5, 'bold', INK, 'right');
    rule(MARGIN, y + rowH, CONTENT_W);
    y += rowH;
  });

  // ----- totals (always foots: subtotal − discounts + delivery fee = total) -----
  const subtotal = Number(order.subtotal) || 0;
  const fee = Number(order.delivery_fee) || 0;
  const total = Number(order.total) || 0;
  // orders has no `discount` column — it is derived, exactly like the webview does.
  const discount = Math.max(0, subtotal - total + fee);
  const adminDiscount = Math.min(Math.max(0, Number(order.additional_discount) || 0), discount);
  const packageDiscount = Math.max(0, discount - adminDiscount);

  const rowList: { label: string; value: string; color?: string }[] = [{ label: 'Subtotal', value: peso(subtotal) }];
  if (packageDiscount > 0) rowList.push({ label: 'Package discount', value: '-' + peso(packageDiscount), color: ACCENT });
  if (adminDiscount > 0) rowList.push({ label: 'Additional discount', value: '-' + peso(adminDiscount), color: ACCENT });
  if (fee > 0) rowList.push({ label: isDelivery ? 'Delivery fee' : 'Delivery fee (waived)', value: peso(fee) });

  const tW = 340;
  const tX = W - MARGIN - tW;
  const lineH = 26;
  const blockH = 16 + rowList.length * lineH + 66;
  y += 22;
  fill(tX, y, tW, blockH, '#ffffff', 12);
  outline(tX, y, tW, blockH, LINE, 12);
  let ty = y + 16;
  for (const r of rowList) {
    text(r.label, tX + 20, ty + 4, 13, 'normal', MUTED);
    text(r.value, tX + tW - 20, ty + 4, 13, 'bold', r.color || INK, 'right');
    ty += lineH;
  }
  rule(tX + 16, ty, tW - 32);
  text('TOTAL', tX + 20, ty + 12, 15, 'bold', INK);
  text(peso(total), tX + tW - 20, ty + 6, 22, 'bold', ACCENT, 'right');
  const payNote = payStatus === 'PAID' ? 'Settled in full — thank you!'
    : payStatus === 'PAYMENT_SUBMITTED' ? 'Payment proof under review.'
      : method === 'COD' ? 'Payable in cash on delivery.' : `Payable via ${method}.`;
  text(payNote, tX + tW - 20, ty + 38, 11.5, 'normal', MUTED, 'right');
  y += blockH;

  // ----- footer -----
  y += 26;
  rule(MARGIN, y, CONTENT_W);
  y += 16;
  text('Thank you for ordering from Postre Food Products!', MARGIN, y, 13, 'bold', ACCENT);
  y += 22;
  setFont(measure, 11.5, 'normal');
  text(fitText(measure, [store.contact_address, store.contact_phone, store.contact_email].filter(Boolean).join('   ·   '), CONTENT_W), MARGIN, y, 11.5, 'normal', MUTED);
  y += 18;
  text(`This document serves as your official sales invoice for order ${order.order_number || ''}.`.trim(), MARGIN, y, 11, 'normal', MUTED);
  y += 28;

  // ----- render the collected ops at the exact height the content needs -----
  const height = Math.max(600, Math.round(y));
  const canvas = createCanvas(W, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, height);
  for (const op of ops) op(ctx);
  return canvas.toBuffer('image/jpeg', 92);
}

// ---------- storage ----------
/** Local fallback folder for invoices. `express.static` serves the public folder
 *  that sits next to the compiled server, so a file dropped here is reachable at
 *  /invoices/<name>. Both `npm start` and `npm run dev` run `dist/server.js`,
 *  hence dist/public is the folder actually served; ./public is the fallback for
 *  an uncompiled run. */
export function invoiceDir(): string {
  const candidates = [
    path.join(process.cwd(), 'dist', 'public', 'invoices'),
    path.join(process.cwd(), 'public', 'invoices'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.dirname(c))) return c;
  }
  return candidates[candidates.length - 1];
}

/** A rendered invoice parked somewhere public just long enough for Messenger to
 *  fetch it. `cleanup` describes the copy WE created so it can be reclaimed. */
interface HostedInvoice {
  url: string;
  cleanup: { kind: 'supabase' | 'local'; ref: string } | null;
}

/** Make the JPEG reachable at a PUBLIC https url Messenger can fetch:
 *  Supabase Storage first (the same bucket that hosts product photos), else the
 *  local public/invoices folder behind BASE_URL. Returns the url plus a handle
 *  for deleting the copy afterwards (storage is only used as a hand-off — see
 *  scheduleInvoiceCleanup). */
async function hostInvoice(buffer: Buffer, fileName: string): Promise<HostedInvoice | null> {
  if (supabaseConfigured()) {
    try {
      const url = await uploadImage(`invoices/${fileName}`, 'image/jpeg', buffer);
      return { url, cleanup: { kind: 'supabase', ref: `invoices/${fileName}` } };
    } catch (e: any) {
      console.warn('[invoice] Supabase upload failed — trying the local folder:', e?.message || e);
    }
  }
  const base = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
  if (!base) {
    console.warn('[invoice] cannot host the invoice image: Supabase not configured and BASE_URL/RENDER_EXTERNAL_URL is not set');
    return null;
  }
  try {
    const dir = invoiceDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, fileName);
    fs.writeFileSync(file, buffer);
    return { url: `${base}/invoices/${fileName}`, cleanup: { kind: 'local', ref: file } };
  } catch (e: any) {
    console.warn('[invoice] local invoice write failed:', e?.message || e);
    return null;
  }
}

// ---------- storage reclaim ----------
// The bucket is a hand-off, not an archive: Messenger downloads the JPEG within
// seconds and re-hosts it on its own CDN, so the copy we uploaded is dead weight
// afterwards. Every send therefore schedules a deferred delete, and a startup
// sweep mops up anything a restart left behind — keeping the bucket from filling
// up with one invoice per completed order.
const CLEANUP_DELAY_MS = Math.max(0, Number(process.env.INVOICE_CLEANUP_DELAY_MS ?? 2 * 60 * 1000));
const ORPHAN_MAX_AGE_MS = Math.max(60_000, Number(process.env.INVOICE_ORPHAN_MAX_AGE_MS ?? 60 * 60 * 1000));

/** Delete the hosted copy — the Supabase object, or the local file we wrote. */
async function removeInvoice(cleanup: HostedInvoice['cleanup']): Promise<boolean> {
  if (!cleanup) return false;
  try {
    if (cleanup.kind === 'supabase') {
      await deleteImages([cleanup.ref]);
    } else {
      fs.unlinkSync(cleanup.ref);
    }
    console.log(`[invoice] reclaimed storage — deleted ${cleanup.kind} copy ${cleanup.ref}`);
    return true;
  } catch (e: any) {
    console.warn(`[invoice] could not delete ${cleanup.kind} copy ${cleanup.ref}:`, e?.message || e);
    return false;
  }
}

/** Delete the hosted copy once Messenger has had time to fetch it. A zero delay
 *  deletes right away — and is AWAITED, so a failed send never leaves a dangling
 *  promise or an unreclaimed object behind. The timer is unref'd so a pending
 *  cleanup never keeps the process alive. */
async function scheduleInvoiceCleanup(cleanup: HostedInvoice['cleanup'], delayMs = CLEANUP_DELAY_MS): Promise<void> {
  if (!cleanup) return;
  if (delayMs <= 0) {
    await removeInvoice(cleanup);
    return;
  }
  const timer = setTimeout(() => void removeInvoice(cleanup), delayMs);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
}

/** Age of a stored object in ms, clamped at 0. Supabase stamps `created_at` on
 *  ITS clock, which can sit a few hundred ms ahead of ours; without the clamp a
 *  just-uploaded object would look like it came from the future and would never
 *  be swept (maxAgeMs = 0 would silently delete nothing). An unusable timestamp
 *  is reported as infinitely old so it can never pin storage. */
function objectAgeMs(f: any): number {
  const at = new Date(f.created_at || f.updated_at || 0).getTime();
  if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Date.now() - at);
}

/** Startup sweep for invoices orphaned by a restart mid-flight (their deferred
 *  delete never ran). Best-effort; called once from server boot. */
export async function sweepInvoices(maxAgeMs = ORPHAN_MAX_AGE_MS): Promise<number> {
  let removed = 0;
  if (supabaseConfigured()) {
    try {
      // A bucket can hold more than one page of objects (and the default list
      // limit is only 100), so page through them. Deleting shifts the offsets,
      // which is why every pass re-lists from the start and a short page ends it.
      for (let pass = 0; pass < 20; pass++) {
        const { data, error } = await supa().storage.from(bucket()).list('invoices', { limit: 1000 });
        if (error) throw new Error(error.message);
        const page = (data || []).filter((f: any) => f && f.id !== null); // folders are listed with a null id
        const stale = page
          .filter((f: any) => objectAgeMs(f) >= maxAgeMs)
          .map((f: any) => `invoices/${f.name}`);
        if (!stale.length) break;
        await deleteImages(stale);
        removed += stale.length;
        console.log(`[invoice] startup sweep deleted ${stale.length} orphaned invoice object(s) from Supabase`);
        if (page.length < 1000) break;
      }
    } catch (e: any) {
      console.warn('[invoice] Supabase startup sweep failed:', e?.message || e);
    }
  }
  try {
    const dir = invoiceDir();
    if (fs.existsSync(dir)) {
      let local = 0;
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        try {
          if (Date.now() - fs.statSync(file).mtimeMs >= maxAgeMs) {
            fs.unlinkSync(file);
            local++;
          }
        } catch { /* a single unreadable file must not stop the sweep */ }
      }
      if (local) {
        removed += local;
        console.log(`[invoice] startup sweep deleted ${local} stale local invoice file(s)`);
      }
    }
  } catch (e: any) {
    console.warn('[invoice] local startup sweep failed:', e?.message || e);
  }
  return removed;
}


/** Completion timestamp for the invoice header. The status-history column has
 *  been named both `changed_at` and `created_at` across schema revisions, so
 *  both are accepted and the order's own created_at is the last resort. */
async function completedAtOf(orderId: number): Promise<string | null> {
  try {
    const { data, error } = await supa().from('order_status_history').select('*').eq('order_id', orderId);
    if (error || !data) return null;
    const done = [...data].reverse().find((h: any) => String(h?.status || '').toUpperCase() === 'COMPLETED');
    return done?.changed_at || done?.created_at || null;
  } catch {
    return null;
  }
}

// ---------- public entry point ----------
/** Build the JPEG invoice for a COMPLETED order and attach it to the
 *  customer's Messenger thread. Best-effort by design: a rendering or upload
 *  failure is logged and returns false — it never breaks order processing. */
export async function sendOrderInvoice(psid: string, orderId: number): Promise<boolean> {
  if (!psid) return false;
  let hosted: HostedInvoice | null = null;
  try {
    const order = await getOrderById(orderId);
    if (!order) {
      console.warn(`[invoice] order #${orderId} not found — nothing to send`);
      return false;
    }
    const items = await getOrderItems(orderId);
    const [custRes, store, completedAt] = await Promise.all([
      order.customer_id
        ? supa().from('customers').select('name, phone').eq('id', order.customer_id).maybeSingle()
        : Promise.resolve({ data: null } as any),
      getStoreInfo(),
      completedAtOf(orderId),
    ]);
    const buffer = renderInvoiceJpeg({
      order,
      items: items || [],
      customer: (custRes as any)?.data || {},
      store,
      completedAt: completedAt || order.created_at,
    });
    const fileName = `invoice-${String(order.order_number || orderId).replace(/[^A-Za-z0-9._-]/g, '')}.jpg`;
    hosted = await hostInvoice(buffer, fileName);
    if (!hosted) return false;
    const sent = await sendImage(psid, hosted.url);
    console.log(`[invoice] ${order.order_number}: ${Math.round(buffer.length / 1024)}KB JPEG -> ${sent.ok ? 'attached' : `send failed (${sent.status || 'error'})`} | ${hosted.url}`);
    // Reclaim the storage we used for the hand-off. Only a copy this function
    // uploaded is ever deleted (never a caller-supplied URL): once Messenger has
    // fetched the image it lives on Facebook's CDN, so the bucket object and the
    // temp file are dead weight. A failed send deletes immediately.
    await scheduleInvoiceCleanup(hosted.cleanup, sent.ok ? CLEANUP_DELAY_MS : 0);
    return sent.ok;
  } catch (e: any) {
    console.warn('[invoice] could not build/send the invoice:', e?.message || e);
    // A failure after the upload leaves an object nothing will ever fetch —
    // reclaim it now rather than waiting for the next startup sweep.
    await scheduleInvoiceCleanup(hosted?.cleanup ?? null, 0);
    return false;
  }
}
