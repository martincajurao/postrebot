import { supa } from '../db/supabase';

export interface SlotAvailability {
  label: string;
  used: number;
  capacity: number;
  full: boolean;
}

export async function isDateOpen(date: string): Promise<{ open: boolean; reason?: string }> {
  const db = supa();
  const { data: blocked } = await db.from('blocked_dates').select('reason').eq('date', date).maybeSingle();
  if (blocked) return { open: false, reason: blocked.reason || 'Closed' };
  const dow = new Date(date + 'T00:00:00').getDay();
  const { data: bh } = await db.from('business_hours').select('*').eq('day_of_week', dow).maybeSingle();
  if (!bh || bh.closed) return { open: false, reason: 'Business closed on this day' };
  return { open: true };
}

export async function slotAvailability(date: string): Promise<SlotAvailability[]> {
  const db = supa();
  const { data: slots } = await db.from('time_slots').select('*').eq('active', 1).order('sort_order');
  return Promise.all((slots || []).map(async (s: any) => {
    const { count } = await db.from('reservations').select('*', { count: 'exact', head: true }).eq('res_date', date).eq('time_slot', s.label).neq('status', 'CANCELLED');
    const used = count || 0;
    return { label: s.label, used, capacity: s.max_capacity, full: used >= s.max_capacity };
  }));
}

/**
 * Reserve a slot with double-booking protection.
 */
export async function createReservation(input: {
  customer_name: string; phone?: string; res_date: string; time_slot: string;
  order_id?: number | null; notes?: string; status?: string;
}) {
  const dateOpen = await isDateOpen(input.res_date);
  if (!dateOpen.open) throw new Error('Date is closed');

  const db = supa();
  const { data: slotData } = await db.from('time_slots').select('*').eq('label', input.time_slot).eq('active', 1).single();
  if (!slotData) throw new Error('Invalid time slot');

  const { count } = await db.from('reservations').select('*', { count: 'exact', head: true }).eq('res_date', input.res_date).eq('time_slot', input.time_slot).neq('status', 'CANCELLED');
  const used = count || 0;
  if (used >= slotData.max_capacity) throw new Error('Time slot is full');

  const { data } = await db.from('reservations').insert({
    order_id: input.order_id ?? null,
    customer_name: input.customer_name,
    phone: input.phone ?? null,
    res_date: input.res_date,
    time_slot: input.time_slot,
    status: input.status ?? 'PENDING',
    notes: input.notes ?? null,
  }).select('id').single();
  return Number(data!.id);
}

export async function cancelReservation(id: number): Promise<void> {
  await supa().from('reservations').update({ status: 'CANCELLED' }).eq('id', id);
}

export async function updateReservationStatus(id: number, status: string): Promise<void> {
  const allowed = ['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED'];
  if (!allowed.includes(status)) throw new Error('Invalid status');
  await supa().from('reservations').update({ status }).eq('id', id);
}

export async function rescheduleReservation(id: number, res_date: string, time_slot: string): Promise<void> {
  const db = supa();
  const { data: res } = await db.from('reservations').select('*').eq('id', id).maybeSingle();
  if (!res) throw new Error('Reservation not found');

  const { data: slotData } = await db.from('time_slots').select('*').eq('label', time_slot).eq('active', 1).single();
  if (!slotData) throw new Error('Invalid time slot');

  const { count } = await db.from('reservations').select('*', { count: 'exact', head: true }).eq('res_date', res_date).eq('time_slot', time_slot).neq('status', 'CANCELLED').neq('id', id);
  const used = count || 0;
  if (used >= slotData.max_capacity) throw new Error('Time slot is full');

  await db.from('reservations').update({ res_date, time_slot }).eq('id', id);
}