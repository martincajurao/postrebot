"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getState = getState;
exports.setState = setState;
exports.sendText = sendText;
exports.sendQuickReplies = sendQuickReplies;
exports.sendButtons = sendButtons;
exports.sendCarousel = sendCarousel;
exports.notifyOrderStatus = notifyOrderStatus;
const database_1 = require("../db/database");
const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';
// ---------- conversation state helpers ----------
function getState(psid) {
    const row = database_1.db.prepare('SELECT state, context_json FROM conversation_states WHERE psid = ?').get(psid);
    return { state: row?.state || 'MAIN_MENU', ctx: row?.context_json ? JSON.parse(row.context_json) : {} };
}
function setState(psid, state, ctx = {}) {
    database_1.db.prepare(`INSERT INTO conversation_states (psid, state, context_json) VALUES (?, ?, ?)
    ON CONFLICT(psid) DO UPDATE SET state = excluded.state, context_json = excluded.context_json,
    updated_at = datetime('now')`).run(psid, state, JSON.stringify(ctx));
}
async function sendApi(body) {
    if (!PAGE_TOKEN) {
        console.log('[messenger:mock-send]', JSON.stringify(body));
        return { ok: true };
    }
    try {
        const res = await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const text = await res.text();
        if (!res.ok)
            console.error(`[messenger] send failed (${res.status}): ${text}`);
        return { ok: res.ok, status: res.status, body: text };
    }
    catch (e) {
        console.error('[messenger] send error:', e?.message || e);
        return { ok: false, body: String(e?.message || e) };
    }
}
function sendText(psid, text) {
    return sendApi({ recipient: { id: psid }, message: { text } });
}
function sendQuickReplies(psid, text, replies) {
    return sendApi({
        recipient: { id: psid },
        message: {
            text,
            quick_replies: replies.slice(0, 13).map((r) => ({
                content_type: 'text', title: r.title.slice(0, 20), payload: r.payload,
            })),
        },
    });
}
function sendButtons(psid, text, buttons) {
    return sendApi({
        recipient: { id: psid },
        message: {
            attachment: {
                type: 'template',
                payload: {
                    template_type: 'button',
                    text: text.slice(0, 640),
                    buttons: buttons.slice(0, 3).map((b) => ({
                        type: 'postback', title: b.title.slice(0, 20), payload: b.payload,
                    })),
                },
            },
        },
    });
}
/** Messenger must be able to download carousel images itself; drop any URL it cannot fetch. */
async function imageUrlOk(url) {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok)
            return false;
        const ct = res.headers.get('content-type') || '';
        return ct === '' || ct.startsWith('image/');
    }
    catch {
        return false;
    }
}
async function sendCarousel(psid, elements) {
    const els = elements.slice(0, 10).map((e) => ({
        title: e.title.slice(0, 80),
        subtitle: (e.subtitle || '').slice(0, 80),
        image_url: e.image_url || undefined,
        buttons: (e.buttons || []).slice(0, 3).map((b) => ({
            type: 'postback', title: b.title.slice(0, 20), payload: b.payload,
        })),
    }));
    // Pre-flight: verify every image URL is publicly reachable, drop the broken ones.
    await Promise.all(els.map(async (e) => {
        if (e.image_url && !(await imageUrlOk(e.image_url))) {
            console.warn(`[messenger] dropping unreachable carousel image: ${e.image_url}`);
            e.image_url = undefined;
        }
    }));
    const send = (list) => sendApi({
        recipient: { id: psid },
        message: {
            attachment: {
                type: 'template',
                payload: { template_type: 'generic', elements: list },
            },
        },
    });
    let result = await send(els);
    // Never lose the whole carousel because of a bad image — retry without images.
    if (!result.ok && els.some((e) => e.image_url)) {
        console.warn('[messenger] carousel with images failed — retrying without images');
        await send(els.map((e) => ({ ...e, image_url: undefined })));
    }
}
// ---------- notification helpers (used by admin actions) ----------
function notifyOrderStatus(psid, status) {
    const messages = {
        CONFIRMED: '✅ Your order has been confirmed.',
        PREPARING: '👨‍🍳 Your order is now being prepared.',
        READY: '🎉 Your order is ready!',
        CANCELLED: '❌ Your order has been cancelled. Contact us if this is unexpected.',
        COMPLETED: '🙏 Thank you for ordering from Postre Food Products!',
    };
    const msg = messages[status];
    if (msg)
        sendText(psid, msg).catch(() => { });
}
