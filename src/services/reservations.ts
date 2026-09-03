import { one, many, run, tx } from '../db';

export interface SlotAvailability {
  label: string;
  used: number;
  capacity: number;
  full: boolean;
}

export async function isDateOpen(date: string): Promise<{ open: boolean; reason?: string }> {
  const blocked = await one('SELECT reason FROM blocked_dates WHERE date = $1', [date]) as any;
  if (blocked) return { open: false, reason: blocked.reason || 'Closed' };
  const dow = new Date(date + 'T00:00:00').getDay();
  const bh = await one('SELECT * FROM business_hours WHERE day_of_week = $1', [dow]) as any;
  if (!bh || bh.closed) return { open: false, reason: 'Business closed on this day' };
  return { open: true };
}

export async function slotAvailability(date: string): Promise<SlotAvailability[]> {
  const slots = await many('SELECT * FROM time_slots WHERE active = 1 ORDER BY sort_order') as any[];
  return Promise.all(slots.map(async (s: any) => {
    const used = (await one(
      "SELECT COUNT(*) c FROM reservations WHERE res_date = $1 AND time_slot = $2 AND status != 'CANCELLED'",
      [date, s.label]) as any).c;
    return { label: s.label, used, capacity: s.max_capacity, full: used >= s.max_capacity };
  }));
}

/**
 * Reserve a slot with double-booking protection.
 * The availability check + insert run inside a single transaction.
 */
export async function createReservation(input: {
  customer_name: string; phone?: string; res_date: string; time_slot: string;
  order_id?: number | null; notes?: string; status?: string;
}) {
  const dateOpen = await isDateOpen(input.res_date);
  if (!dateOpen.open) throw new Error('Date is closed');
  
  return await tx(async (client) => {
    const slot = await client.query('SELECT * FROM time_slots WHERE label = $1 AND active = 1', [input.time_slot]);
    if (slot.rows.length === 0) throw new Error('Invalid time slot');
    const slotData = slot.rows[0];
    const usedRes = await client.query(
      "SELECT COUNT(*) c FROM reservations WHERE res_date = $1 AND time_slot = $2 AND status != 'CANCELLED'",
      [input.res_date, input.time_slot]);
    const used = Number(usedRes.rows[0].c);
    if (used >= slotData.max_capacity) throw new Error('Time slot is full');
    const r = await client.query(`INSERT INTO reservations (order_id, customer_name, phone, res_date, time_slot, status, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.order_id ?? null, input.customer_name, input.phone ?? null,
        input.res_date, input.time_slot, input.status ?? 'PENDING', input.notes ?? null]);
    return Number(r.rows[0].id);
  });
}

export async function cancelReservation(id: number): Promise<void> {
  await run("UPDATE reservations SET status = 'CANCELLED' WHERE id = $1", [id]);
}

export async function updateReservationStatus(id: number, status: string): Promise<void> {
  const allowed = ['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED'];
  if (!allowed.includes(status)) throw new Error('Invalid status');
  await run('UPDATE reservations SET status = $1 WHERE id = $2', [status, id]);
}

export async function rescheduleReservation(id: number, res_date: string, time_slot: string): Promise<void> {
  const res = await one('SELECT * FROM reservations WHERE id = $1', [id]) as any;
  if (!res) throw new Error('Reservation not found');
  
  await tx(async (client) => {
    const slotRes = await client.query('SELECT * FROM time_slots WHERE label = $1 AND active = 1', [time_slot]);
    if (slotRes.rows.length === 0) throw new Error('Invalid time slot');
    const slot = slotRes.rows[0];
    const usedRes = await client.query(
      "SELECT COUNT(*) c FROM reservations WHERE res_date = $1 AND time_slot = $2 AND status != 'CANCELLED' AND id != $3",
      [res_date, time_slot, id]);
    const used = Number(usedRes.rows[0].c);
    if (used >= slot.max_capacity) throw new Error('Time slot is full');
    await client.query('UPDATE reservations SET res_date = $1, time_slot = $2 WHERE id = $3', [res_date, time_slot, id]);
  });
}