﻿import { supa } from '../db/supabase';
/**
 * Reservation status that mirrors each order lifecycle status. Reservations have
 * no PREPARING/READY — an in-progress order stays CONFIRMED on the schedule board.
 */
export const RESV_STATUS_FOR_ORDER: Record<string, string> = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  PREPARING: 'CONFIRMED',
  READY: 'CONFIRMED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
};

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

export async function getReservationByOrderId(orderId: number): Promise<any | null> {
  const { data } = await supa().from('reservations').select('*').eq('order_id', orderId).maybeSingle();
  return data;
}

/**
 * Mirror an order's lifecycle onto its linked reservation (idempotent):
 *  - CONFIRMED / PREPARING / READY → reservation CONFIRMED (in progress)
 *  - COMPLETED → reservation COMPLETED, CANCELLED → reservation CANCELLED
 * Creates the reservation if a scheduled order has none yet.
 * This is the ONE sync path — used by admin status changes AND bot flows.
 */
export async function syncReservationFromOrder(orderId: number): Promise<void> {
  if (!orderId) return;
  const db = supa();
  const { data: order } = await db.from('orders').select('*, customers(name, phone)').eq('id', orderId).maybeSingle();
  if (!order) return;
  const target = RESV_STATUS_FOR_ORDER[order.status];
  if (!target) return;
  const { data: res } = await db.from('reservations').select('id, status').eq('order_id', order.id).maybeSingle();
  if (res) {
    if (res.status !== target) await db.from('reservations').update({ status: target }).eq('id', res.id);
    return;
  }
  if (order.fulfillment_date && order.time_slot) await ensureReservationFromOrder(order);
}

/**
 * Mirror a reservation status change onto its linked order (escalation only —
 * a reservation can confirm/complete/cancel the order, never move it backwards).
 * Writes order_status_history; customer notifications stay in the API layer.
 */
export async function syncOrderFromReservation(orderId: number, resStatus: string): Promise<{ changed: boolean; status?: string }> {
  if (!orderId) return { changed: false };
  const db = supa();
  const { data: order } = await db.from('orders').select('id, status').eq('id', orderId).maybeSingle();
  if (!order) return { changed: false };
  const target =
    resStatus === 'CANCELLED' ? 'CANCELLED'
    : resStatus === 'COMPLETED' ? 'COMPLETED'
    : resStatus === 'CONFIRMED' ? (order.status === 'PENDING' ? 'CONFIRMED' : order.status)
    : null;
  if (!target || target === order.status) return { changed: false, status: order.status };
  await db.from('orders').update({ status: target }).eq('id', order.id);
  await db.from('order_status_history').insert({ order_id: order.id, status: target });
  return { changed: true, status: target };
}

/**
 * Convert a confirmed order into a reservation (idempotent). Skips the
 * date-open / slot-capacity checks — an existing customer order must not be
 * rejected at confirm time. Returns the reservation id (or null if the order
 * has no fulfillment date/slot to reserve).
 */
export async function ensureReservationFromOrder(order: any): Promise<number | null> {
  if (!order?.id) return null;
  const db = supa();
  const { data: existing } = await db.from('reservations').select('id').eq('order_id', order.id).maybeSingle();
  if (existing) return Number(existing.id); // already converted

  const resDate = order.fulfillment_date || null;
  const timeSlot = order.time_slot || null;
  if (!resDate || !timeSlot) return null; // nothing to schedule

  const customerName = order.customer_name || order.customers?.name || 'Customer';
  const notes = order.order_type === 'delivery'
    ? `Delivery — ${order.address || ''}`
    : 'Pickup';

  const { data, error } = await db.from('reservations').insert({
    order_id: order.id,
    customer_name: customerName,
    phone: order.phone || null,
    res_date: resDate,
    time_slot: timeSlot,
    status: RESV_STATUS_FOR_ORDER[order.status] || 'CONFIRMED',
    notes,
  }).select('id').single();
  if (error) throw new Error(error.message);
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