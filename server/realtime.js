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
const ban = require('./ban');

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
        /*
         * بنِ IP روی سوکت هم اعمال می‌شود؛ وگرنه کاربرِ بن‌شده با همان
         * اتصالِ باز، رویدادها را می‌گرفت و فقط REST برایش بسته بود.
         */
        const ip = ban.clientIp(socket.request || {});
        let hit = null;
        try { hit = ban.isIpBanned(getDb(), ip); } catch { /* ignore */ }
        if (hit) {
            socket.emit('banned', { message: 'دسترسی این نشانی مسدود شده است' + (hit.reason ? ' — ' + hit.reason : '') });
            socket.disconnect(true);
            return;
        }
        socket.data.ip = ip;

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

        /*
         * تماس یک‌به‌یک: سیگنال offer/accept/signal/reject/end بین دو نفر رله
         * می‌شود. رسانه خودش P2P است و از سرور رد نمی‌شود.
         * برای call_offer، اگر طرف مقابل آنلاین نباشد یک Web Push هم می‌رود تا
         * گوشی‌اش با اپِ بسته زنگ بخورد.
         */
        const relayCall = (event, data) => {
            if (!data) return;
            const from = Number((socket.data && socket.data.userId) || data.from) || 0;
            const to = Number(data.to);
            if (!from || !to || to === from) return;
            const actor = getDb().get('SELECT full_name, username FROM users WHERE id = ?', from) || {};
            const payload = Object.assign({}, data, { from, fromName: actor.full_name || actor.username || '' });
            rt_emitTo([to], event, payload);
            return payload;
        };

        socket.on('call_offer', data => {
            const payload = relayCall('call_offer', data);
            if (!payload) return;
            const to = Number(data.to);
            if (isOnline(to)) return;
            /* آفلاین است → اعلان سیستم‌عامل، وگرنه تماس را هیچ‌وقت نمی‌بیند */
            try {
                const push = require('./push');
                const actor = getDb().get('SELECT full_name FROM users WHERE id = ?', payload.from) || {};
                push.pushTo(getDb(), to, {
                    title: '\u{1F4DE} ' + (actor.full_name || payload.fromName || 'تماس ورودی'),
                    body: data.video ? 'تماس تصویری ورودی' : 'تماس صوتی ورودی',
                    tag: 'call', peer: payload.from, call: data.callId || null, url: 'index.html'
                }).catch(() => {});
            } catch { /* ماژول پوش اختیاری است */ }
        });
        socket.on('call_accept', data => relayCall('call_accept', data));
        socket.on('call_signal', data => relayCall('call_signal', data));
        socket.on('call_reject', data => relayCall('call_reject', data));
        socket.on('call_end', data => relayCall('call_end', data));

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
    /**
     * بیرون‌انداختن یک کاربر از همهٔ نشست‌هایش.
     *
     * عمداً از reset() استفاده نمی‌کنیم: آن یکی کل سرور را می‌بندد و همهٔ
     * کاربران را قطع می‌کند، در حالی که اینجا فقط بن‌شده باید برود.
     */
    kickUser(userId, reason) {
        if (!io || !userId) return 0;
        let count = 0;
        const msg = 'حساب کاربری تو مسدود شد' + (reason ? ' — ' + reason : '');
        for (const s of io.sockets.sockets.values()) {
            if (Number(s.data && s.data.userId) === Number(userId)) {
                s.emit('banned', { message: msg });
                s.disconnect(true);
                count++;
            }
        }
        presence.delete(Number(userId));
        return count;
    },

    /** بیرون‌انداختن هر اتصال‌هایی که از یک IP (خام یا CIDR) آمده‌اند */
    kickIp(ip) {
        if (!io || !ip) return 0;
        let count = 0;
        for (const s of io.sockets.sockets.values()) {
            if (ban.ipMatches(ip, s.data && s.data.ip)) {
                s.emit('banned', { message: 'دسترسی این نشانی مسدود شد' });
                s.disconnect(true);
                count++;
            }
        }
        return count;
    },
    /** برای تست و خاموش‌کردن سرور: بستن سوکت‌ها و پاک‌کردن حضور */
    reset() { presence.clear(); if (io) { io.close(); io = null; } }
};
