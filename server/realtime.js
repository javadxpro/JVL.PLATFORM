'use strict';

/**
 * لایهٔ بلادرنگ (Socket.IO): حضور کاربران، رلهٔ تایپینگ و سیگنال WebRTC،
 * و هلپرهای انتشار رویداد که لایهٔ HTTP از آن‌ها استفاده می‌کند.
 *
 * اتاق‌ها:
 *   user:<id>  → همهٔ سوکت‌های یک کاربر (کلاینت فقط «join» با user_id می‌فرستد)
 *   <room>     → اتاق‌های ویس (کلاینت نام خام «global_voice» را می‌فرستد)
 *
 * رویدادهای گروه‌ها به اتاق user همهٔ اعضا فرستاده می‌شوند، چون کلاینت هیچ‌وقت
 * عضو اتاق گروه نمی‌شود.
 */

const { getDb } = require('./db');

let io = null;
/** userId → Set<socketId> */
const presence = new Map();

const userRoom = id => `user:${id}`;

/** اعضای یک گروه از دیتابیس */
function groupMembers(groupId) {
    try {
        return getDb().all('SELECT user_id FROM group_members WHERE group_id = ?', Number(groupId)).map(r => r.user_id);
    } catch { return []; }
}

/** انتشار به اتاق user مجموعه‌ای از کاربران */
function rt_emitTo(ids, event, payload) {
    if (!io) return;
    const rooms = Array.from(new Set((ids || []).filter(Boolean).map(userRoom)));
    if (rooms.length) io.to(rooms).emit(event, payload);
}

function attach(server, options = {}) {
    const { Server } = require('socket.io');
    io = new Server(server, {
        cors: { origin: '*' },
        maxHttpBufferSize: 1e6,
        pingTimeout: 60000,
        ...options
    });

    io.on('connection', socket => {
        socket.on('join', data => {
            const uid = Number(data && data.user_id);
            if (!uid) return;
            socket.data.userId = uid;
            socket.join(userRoom(uid));
            if (!presence.has(uid)) presence.set(uid, new Set());
            presence.get(uid).add(socket.id);
            broadcastUserStatus();
        });

        /* تایپینگ: رله به مخاطب (یا همهٔ اعضای گروه جز فرستنده) */
        socket.on('typing', data => {
            if (!data) return;
            const from = Number(data.from);
            const to = Number(data.to);
            if (!from || !to) return;
            const payload = { from, to, scope: data.scope === 'group' ? 'group' : 'user', name: data.name || '' };
            const targets = payload.scope === 'group' ? groupMembers(to) : [to];
            rt_emitTo(targets.filter(id => id !== from), 'typing', payload);
        });

        /* ویس‌چت: سیگنال‌دهی WebRTC بین اعضای اتاق */
        socket.on('join_voice', data => { if (data && data.room) socket.join(String(data.room)); });
        socket.on('leave_voice', data => { if (data && data.room) socket.leave(String(data.room)); });
        socket.on('voice_signal', data => {
            if (!data || !data.room) return;
            socket.to(String(data.room)).emit('voice_signal', {
                room: String(data.room),
                sender: Number(data.sender) || (socket.data ? socket.data.userId : 0),
                signal: data.signal || {}
            });
        });

        socket.on('disconnect', () => {
            const uid = socket.data && socket.data.userId;
            if (!uid) return;
            const set = presence.get(uid);
            if (set) {
                set.delete(socket.id);
                if (!set.size) presence.delete(uid);
            }
            broadcastUserStatus();
        });
    });

    return io;
}

function isOnline(userId) {
    const set = presence.get(Number(userId));
    return !!(set && set.size);
}

function onlineIds() {
    return Array.from(presence.keys());
}

/* ───────── هلپرهای انتشار ───────── */

function broadcast(event, payload) { if (io) io.emit(event, payload); }

function broadcastUserStatus() {
    broadcast('user_status', { online: onlineIds(), at: Date.now() });
}

module.exports = {
    attach,
    isOnline,
    onlineIds,
    broadcast,
    broadcastUserStatus,
    emitTo: rt_emitTo,
    /** برای تست و خاموش‌کردن سرور: بستن سوکت‌ها و پاک‌کردن حضور */
    reset() { presence.clear(); if (io) { io.close(); io = null; } }
};
