"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDateOpen = isDateOpen;
exports.slotAvailability = slotAvailability;
exports.createReservation = createReservation;
exports.cancelReservation = cancelReservation;
exports.updateReservationStatus = updateReservationStatus;
exports.rescheduleReservation = rescheduleReservation;
const database_1 = require("../db/database");
function isDateOpen(date) {
    const blocked = database_1.db.prepare('SELECT reason FROM blocked_dates WHERE date = ?').get(date);
    if (blocked)
        return { open: false, reason: blocked.reason || 'Closed' };
    const dow = new Date(date + 'T00:00:00').getDay();
    const bh = database_1.db.prepare('SELECT * FROM business_hours WHERE day_of_week = ?').get(dow);
    if (!bh || bh.closed)
        return { open: false, reason: 'Business closed on this day' };
    return { open: true };
}
function slotAvailability(date) {
    const slots = database_1.db.prepare('SELECT * FROM time_slots WHERE active = 1 ORDER BY sort_order').all();
    return slots.map((s) => {
        const used = database_1.db.prepare("SELECT COUNT(*) c FROM reservations WHERE res_date = ? AND time_slot = ? AND status != 'CANCELLED'").get(date, s.label).c;
        return { label: s.label, used, capacity: s.max_capacity, full: used >= s.max_capacity };
    });
}
/**
 * Reserve a slot with double-booking protection.
 * The availability check + insert run inside a single transaction.
 */
function createReservation(input) {
    if (!isDateOpen(input.res_date).open)
        throw new Error('Date is closed');
    const tx = database_1.db.transaction(() => {
        const slot = database_1.db.prepare('SELECT * FROM time_slots WHERE label = ? AND active = 1').get(input.time_slot);
        if (!slot)
            throw new Error('Invalid time slot');
        const used = database_1.db.prepare("SELECT COUNT(*) c FROM reservations WHERE res_date = ? AND time_slot = ? AND status != 'CANCELLED'").get(input.res_date, input.time_slot).c;
        if (used >= slot.max_capacity)
            throw new Error('Time slot is full');
        const r = database_1.db.prepare(`INSERT INTO reservations (order_id, customer_name, phone, res_date, time_slot, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.order_id ?? null, input.customer_name, input.phone ?? null, input.res_date, input.time_slot, input.status ?? 'PENDING', input.notes ?? null);
        return Number(r.lastInsertRowid);
    });
    return tx();
}
function cancelReservation(id) {
    database_1.db.prepare("UPDATE reservations SET status = 'CANCELLED' WHERE id = ?").run(id);
}
function updateReservationStatus(id, status) {
    const allowed = ['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED'];
    if (!allowed.includes(status))
        throw new Error('Invalid status');
    database_1.db.prepare('UPDATE reservations SET status = ? WHERE id = ?').run(status, id);
}
function rescheduleReservation(id, res_date, time_slot) {
    const res = database_1.db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
    if (!res)
        throw new Error('Reservation not found');
    const tx = database_1.db.transaction(() => {
        const slot = database_1.db.prepare('SELECT * FROM time_slots WHERE label = ? AND active = 1').get(time_slot);
        if (!slot)
            throw new Error('Invalid time slot');
        const used = database_1.db.prepare("SELECT COUNT(*) c FROM reservations WHERE res_date = ? AND time_slot = ? AND status != 'CANCELLED' AND id != ?").get(res_date, time_slot, id).c;
        if (used >= slot.max_capacity)
            throw new Error('Time slot is full');
        database_1.db.prepare('UPDATE reservations SET res_date = ?, time_slot = ? WHERE id = ?').run(res_date, time_slot, id);
    });
    tx();
}
