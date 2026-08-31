import { db } from '../db/database';

export interface SlotAvailability {
  label: string;
  used: number;
  capacity: number;
  full: boolean;
}

export function isDateOpen(date: string): { open: boolean; reason?: string } {
  const blocked = db.prepare('SELECT reason FROM blocked_dates WHERE date = ?').get(date) as any;
  if (blocked) return { open: false, reason: blocked.reason || 'Closed' };
  const dow = new Date(date + 'T00:00:00').getDay();
  const bh = db.prepare('SELECT * FROM business_hours WHERE day_of_week = ?').get(dow) as any;
  if (!bh || bh.closed) return { open: false, reason: 'Business closed on this day' };
  return { open: true };
}

export function slotAvailability(date: string): SlotAvailability[] {
  const slots = db.prepare('SELECT * FROM time_slots WHERE active = 1 ORDER BY sort_order').all() as any[];
  return slots.map((s: any) => {
    const used = (db.prepare(
      "SELECT COUNT(*) c FROM reservations WHERE res_date = ? AND time_slot = ? AND status != 'CANCELLED'"
    ).get(date, s.label) as any).c;
    return { label: s.label, used, capacity: s.max_capacity, full: used >= s.max_capacity };
  });
}

/**
 * Reserve a slot with double-booking protection.
 * The availability check + insert run inside a single transaction.
 */
export function createReservation(input: {
  customer_name: string; phone?: string; res_date: string; time_slot: string;
  order_id?: number | null; notes?: string; status?: string;
}) {
  if (!isDateOpen(input.res_date).open) throw new Error('Date is closed');
  const tx = db.transaction(() => {
    const slot = db.prepare('SELECT * FROM time_slots WHERE label = ? AND active = 1').get(input.time_slot) as any;
    if (!slot) throw new Error('Invalid time slot');
    const used = (db.prepare(
      "SELECT COUNT(*) c FROM reservations WHERE res_date = ? AND time_slot = ? AND status != 'CANCELLED'"
    ).get(input.res_date, input.time_slot) as any).c;
    if (used >= slot.max_capacity) throw new Error('Time slot is full');
    const r = db.prepare(`INSERT INTO reservations (order_id, customer_name, phone, res_date, time_slot, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      input.order_id ?? null, input.customer_name, input.phone ?? null,
      input.res_date, input.time_slot, input.status ?? 'PENDING', input.notes ?? null);
    return Number(r.lastInsertRowid);
  });
  return tx();
}

export function cancelReservation(id: number): void {
  db.prepare("UPDATE reservations SET status = 'CANCELLED' WHERE id = ?").run(id);
}

export function updateReservationStatus(id: number, status: string): void {
  const allowed = ['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED'];
  if (!allowed.includes(status)) throw new Error('Invalid status');
  db.prepare('UPDATE reservations SET status = ? WHERE id = ?').run(status, id);
}

export function rescheduleReservation(id: number, res_date: string, time_slot: string): void {
  const res = db.prepare('SELECT * FROM reservations WHERE id = ?').get(id) as any;
  if (!res) throw new Error('Reservation not found');
  const tx = db.transaction(() => {
    const slot = db.prepare('SELECT * FROM time_slots WHERE label = ? AND active = 1').get(time_slot) as any;
    if (!slot) throw new Error('Invalid time slot');
    const used = (db.prepare(
      "SELECT COUNT(*) c FROM reservations WHERE res_date = ? AND time_slot = ? AND status != 'CANCELLED' AND id != ?"
    ).get(res_date, time_slot, id) as any).c;
    if (used >= slot.max_capacity) throw new Error('Time slot is full');
    db.prepare('UPDATE reservations SET res_date = ?, time_slot = ? WHERE id = ?').run(res_date, time_slot, id);
  });
  tx();
}
