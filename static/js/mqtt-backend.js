/* ═══════════════════════════════════════════════════════════════════════════
   JVL · لایهٔ MQTT — سرور مجازی داخل مرورگر
   ─────────────────────────────────────────────────────────────────────────
   این فایل جای کل بک‌اند را می‌گیرد: همان ۵۰ مسیر HTTP و همان ۱۵ رویداد
   Socket.IO که index.html مصرف می‌کند، اما روی MQTT-over-WebSocket و بدون
   هیچ ذخیره‌سازی سمت سرور.

   حالت کار:
     · state  → پیام‌های «retained» بروکر (آخرین مقدار هر تاپیک)
     · rooydad → پیام‌های معمولی (غیر retained) روی تاپیک‌های evt/*
     · hozour  → retained + Last-Will: با قطع اتصال، خود بروکر آفلاین می‌زند

   چون همه‌چیز pub/sub است، صفحه کاملاً استاتیک می‌شود و روی GitHub Pages
   هم اجرا می‌شود (بدون نود، بدون دیتابیس، بدون دیسک).

   نکتهٔ امنیتی: روی بروکر عمومی هیچ احراز هویت واقعی وجود ندارد؛ رمزها فقط
   برای جلوگیری از ورود تصادفی هش می‌شوند. برای شبکهٔ جدی، بروکر خصوصی با
   ACL استفاده کن (JVL.setBroker).
   ═══════════════════════════════════════════════════════════════════════ */

(function (root) {
    'use strict';

    /* ───────── تنظیمات ───────── */

    const BROKERS = [
        'wss://broker.emqx.io:8084/mqtt',
        'wss://broker.hivemq.com:8884/mqtt',
        'wss://test.mosquitto.org:8081/mqtt'
    ];

    const LS = {
        broker: 'jvl_broker',
        key: 'jvl_network',
        user: 'volexturn_user',
        token: 'volexturn_token',
        notifs: 'jvl_notifications',
        groupRead: 'jvl_group_read',
        history: 'jvl_history'
    };

    /* سقف حجم رسانه در MQTT — بروکرهای عمومی بستهٔ ~۱MB دارند و base64 هم
       حجم را ۴/۳ می‌کند، پس هدف را کوچک نگه می‌داریم. */
    /*
     * سقف رسانه در حالت MQTT:
     *  - عکس/صوت کوتاه داخل یک پیام retained (بروکرهای عمومی ~۱MB سقف بسته دارند،
     *    و base64 حجم را ۳۳٪ باد می‌کند، پس ۷۰۰KB متن جای امنی است).
     *  - ویدیو/فایل بزرگ‌تر فقط در چت و به‌صورت تکه‌تکه (غیر retained = موقتی).
     */
    const MEDIA_LIMIT = 700 * 1024;
    const CHUNK_TEXT = 120 * 1024;          /* اندازهٔ هر تکهٔ base64 */
    const STREAM_LIMIT = 10 * 1024 * 1024;  /* سقف ویدیو در چت */
    const PART_TTL_MS = 120000;             /* انتقال نیمه‌تمام بعد از این مدت دور ریخته می‌شود */
    const MEDIA_CACHE_MAX = 60;

    const memoryLS = (() => {
        const m = new Map();
        return {
            getItem: k => (m.has(k) ? m.get(k) : null),
            setItem: (k, v) => m.set(k, String(v)),
            removeItem: k => m.delete(k)
        };
    })();
    const store = (typeof localStorage !== 'undefined') ? localStorage : memoryLS;

    const Config = {
        broker: store.getItem(LS.broker) || BROKERS[0],
        networkKey: store.getItem(LS.key) || 'volexturn4',
        appVersion: '4.0.0',
        appName: 'Volexturn',
        storyTtlHours: 24,
        mediaLimit: MEDIA_LIMIT, streamLimit: STREAM_LIMIT, chunkText: CHUNK_TEXT
    };

    const P = () => `jvl/${Config.networkKey}/v1`;

    /* ───────── ابزارها ───────── */

    const mqttLib = (typeof module !== 'undefined' && module.exports && typeof require === 'function')
        ? require('mqtt')
        : root.mqtt;

    function now(d = new Date()) {
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
    const plusHours = (h, from = new Date()) => now(new Date(from.getTime() + h * 3600 * 1000));

    /** شناسهٔ عددی ۱۵ رقمی — کلاینت در چند جا مقایسهٔ عددی دارد */
    function newId() {
        return Date.now() * 100 + Math.floor(Math.random() * 100);
    }

    async function sha256(text) {
        try {
            const c = (root.crypto && root.crypto.subtle) ? root.crypto.subtle : null;
            if (!c) return fallbackHash(text);
            const buf = await c.digest('SHA-256', new TextEncoder().encode(text));
            return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
        } catch {
            return fallbackHash(text);
        }
    }
    /** فقط برای محیط‌های بدون SubtleCrypto؛ امنیت واقعی محسوب نمی‌شود */
    function fallbackHash(text) {
        let h1 = 0x811c9dc5, h2 = 0x01000193;
        for (let i = 0; i < text.length; i++) {
            h1 = Math.imul(h1 ^ text.charCodeAt(i), 16777619) >>> 0;
            h2 = Math.imul(h2 + text.charCodeAt(i) * (i + 7), 2246822519) >>> 0;
        }
        return `f${h1.toString(16)}${h2.toString(16)}`;
    }

    function readJSON(key, fallback) {
        try { const v = store.getItem(key); return v ? JSON.parse(v) : fallback; }
        catch { return fallback; }
    }
    const writeJSON = (key, value) => { try { store.setItem(key, JSON.stringify(value)); } catch { /* پر بودن localStorage */ } };

    function me() {
        const u = readJSON(LS.user, null);
        return u && u.id ? u : null;
    }

    /* ───────── حافظهٔ state (کش پیام‌های retained) ───────── */

    /** topic → payload */
    const cache = new Map();
    /** پیام‌های چت (گذرا، فقط در حافظهٔ همین مرورگر) */
    const msgCache = [];
    const listeners = { state: new Set() };

    function onStateChange(fn) { listeners.state.add(fn); return () => listeners.state.delete(fn); }
    function fireState(kind, payload) { for (const fn of listeners.state) { try { fn(kind, payload); } catch { /* ignore */ } } }

    function prefixDocs(prefix) {
        const base = `${P()}/${prefix}/`;
        const out = [];
        for (const [topic, value] of cache) {
            if (topic.startsWith(base)) out.push({ topic, value, suffix: topic.slice(base.length) });
        }
        return out;
    }
    const getDoc = suffix => cache.get(`${P()}/${suffix}`) || null;

    /* ───────── اتصال MQTT ───────── */

    let client = null;
    let connecting = null;
    let ready = false;
    let willUserId = null;
    const pending = [];

    function willTopic() {
        const u = me();
        return u ? `${P()}/presence/${u.id}` : null;
    }

    function connect() {
        const wanted = me() ? me().id : null;
        /* هویت عوض شده (لاگین/ثبت‌نام) → باید با Last Will درستِ همان کاربر وصل شویم */
        if (client && ready && willUserId === wanted) return Promise.resolve();
        if (client && ready && willUserId !== wanted) {
            try { client.end(true); } catch { /* ignore */ }
            client = null; ready = false; connecting = null;
        }
        if (connecting) return connecting;

        connecting = new Promise((resolve, reject) => {
            if (!mqttLib) { reject(new Error('کتابخانهٔ mqtt بارگذاری نشد')); return; }
            const u = me();
            const opts = {
                clientId: `jvl_${u ? u.id : 'anon'}_${Math.random().toString(16).slice(2, 8)}`,
                clean: true,
                connectTimeout: 12000,
                reconnectPeriod: 3000,
                keepalive: 30
            };
            /* Last Will: اگر مرورگر بسته شود، خودِ بروکر آفلاین را retained می‌کند */
            const wt = willTopic();
            if (wt) {
                opts.will = {
                    topic: wt,
                    payload: JSON.stringify({ online: false, at: now(), id: u.id, name: u.full_name }),
                    qos: 1,
                    retain: true
                };
            }

            try { client = mqttLib.connect(Config.broker, opts); }
            catch (e) { connecting = null; reject(e); return; }

            const timeout = setTimeout(() => {
                if (!ready) { try { client.end(true); } catch { /* ignore */ } connecting = null; reject(new Error('اتصال به بروکر MQTT ناموفق بود')); }
            }, 14000);

            client.on('connect', () => {
                clearTimeout(timeout);
                client.subscribe(`${P()}/#`, { qos: 1 }, () => {
                    ready = true;
                    willUserId = u ? u.id : null;
                    connecting = null;
                    if (u) publishPresence(true);
                    while (pending.length) { const f = pending.shift(); try { f(); } catch { /* ignore */ } }
                    fireState('connected', {});
                    resolve();
                });
            });
            client.on('error', () => { /* reconnectPeriod خودش تلاش می‌کند */ });
            client.on('close', () => { if (ready) fireState('offline', {}); });
            client.on('message', onMessage);
        });
        return connecting;
    }

    function onMessage(topic, payload) {
        const text = payloadToString(payload);
        const isEvent = topic.startsWith(`${P()}/evt/`);

        if (!isEvent) {
            if (text === '') {
                if (cache.delete(topic)) fireState('doc-removed', { topic });
            } else {
                let value;
                try { value = JSON.parse(text); } catch { return; }
                const had = cache.has(topic);
                cache.set(topic, value);
                fireState(had ? 'doc-updated' : 'doc-added', { topic, value });
            }
            return;
        }
        if (text === '') return;
        let event;
        try { event = JSON.parse(text); } catch { return; }
        handleEvent(topic, event);
    }

    function payloadToString(payload) {
        if (typeof payload === 'string') return payload;
        if (payload && typeof payload.toString === 'function') return payload.toString();
        return '';
    }

    function publish(topic, value, opts = {}) {
        const payload = value === null ? '' : JSON.stringify(value);
        const send = () => {
            if (!client || !ready) { pending.push(send); return; }
            client.publish(topic, payload, { qos: opts.qos || 1, retain: opts.retain !== false }, () => {});
        };
        /* خوش‌بینانه: کش خودمان را همین حالا به‌روز می‌کنیم تا UI منتظر اکوی بروکر نماند */
        if (opts.retain !== false) {
            if (value === null) cache.delete(topic); else cache.set(topic, value);
            fireState(value === null ? 'doc-removed' : 'doc-added', { topic, value });
        }
        send();
        return true;
    }

    /* ───────── حضور ───────── */

    let lastOnlineKey = null;

    let lastPresenceAt = 0;

    function publishPresence(online) {
        const u = me();
        if (!u) return;
        /* اگر همین حالا آنلاین اعلام شده، دوباره نویز نفرست */
        const topic = `${P()}/presence/${u.id}`;
        const cur = cache.get(topic);
        if (online && cur && cur.online && Date.now() - lastPresenceAt < 20000) return;
        lastPresenceAt = Date.now();
        publish(topic, { online: !!online, at: now(), id: u.id, name: u.full_name, username: u.username });
    }

    const isOnline = uid => {
        const d = getDoc(`presence/${uid}`);
        return !!(d && d.online);
    };

    /* ───────── رویدادهای زنده (جایگزین Socket.IO) ───────── */

    function handleEvent(topic, event) {
        const tail = topic.slice(`${P()}/evt/`.length);
        const self = me();
        const myId = self ? self.id : null;

        if (tail.startsWith('dm/')) {
            const targetId = Number(tail.slice(3));
            if (targetId !== myId) return;
            applyMessageEvent(event);
        } else if (tail.startsWith('group/')) {
            const gid = Number(tail.slice(6).split('/')[0]);
            if (!isGroupMember(gid, myId)) return;
            applyMessageEvent(event, gid);
        } else if (tail.startsWith('notify/')) {
            const uid = Number(tail.slice(7));
            if (uid !== myId) return;
            if (pushLocalNotification(event)) socketEmit('notify', event);
        } else if (tail.startsWith('call/')) {
            /* سیگنال تماس یک‌به‌یک: offer/accept/reject/end/signal */
            const uid = Number(tail.slice(5));
            if (uid !== myId) return;
            if (event.from === myId) return;
            socketEmit('call_' + event.t, event);
        } else if (tail.startsWith('voice/')) {
            /* سیگنال خودمان را به خودمان برنمی‌گردانیم (مثل socket.to در سرور) */
            if (event.sender === myId) return;
            socketEmit('voice_signal', { room: tail.slice(6), sender: event.sender, signal: event.signal || {} });
        } else if (tail === 'global') {
            socketEmit(event.t, event.data);
        }
    }

    function applyMessageEvent(event, groupId) {
        const self = me();
        const myId = self ? self.id : null;
        if (event.t === 'chunk') {
            receiveChunk(event);
            return;
        }
        if (event.t === 'msg') {
            /* بروکر پیام را به فرستنده هم اکو می‌کند؛ یک بار بیشتر ثبت نشود */
            if (msgCache.some(x => x.id === event.m.id)) return;
            const scope = event.m.group_id ? `g-${event.m.group_id}`
                : `u-${Math.min(event.m.sender_id, event.m.receiver_id)}-${Math.max(event.m.sender_id, event.m.receiver_id)}`;
            const pin = getDoc(`pin/${scope}`);
            if (pin && pin.message_id === event.m.id) event.m.pinned = true;
            msgCache.push(event.m);
            socketEmit('new_message', event.m);
        } else if (event.t === 'edit') {
            const m = msgCache.find(x => x.id === event.message_id);
            if (m) { m.content = event.content; m.edited_at = event.edited_at; }
            socketEmit('message_updated', { message_id: event.message_id });
        } else if (event.t === 'delete') {
            const i = msgCache.findIndex(x => x.id === event.message_id);
            if (i >= 0) msgCache.splice(i, 1);
            socketEmit('message_deleted', { message_id: event.message_id });
        } else if (event.t === 'seen') {
            /*
             * event.by خوانده، event.partner صاحب پیام‌هاست؛ پس پیام‌های خوانده‌شده
             * آن‌هایی هستند که partner فرستاده و by گرفته است.
             */
            msgCache.forEach(m => {
                if (groupId) { if (m.group_id === groupId) m.seen = true; }
                else if (m.sender_id === event.partner && m.receiver_id === event.by) m.seen = true;
            });
            /*
             * فقط صاحب پیام‌ها تیک‌ها را به‌روز می‌بیند. اگر به خودِ خواننده هم
             * بدهیم، loadMessages دوباره صدا زده می‌شود و حلقهٔ بی‌نهایت
             * seen→loadMessages→seen ساخته می‌شود.
             */
            if (event.partner === myId) {
                socketEmit('messages_seen', { by: event.by, partner: event.partner });
            }
        } else if (event.t === 'clear') {
            for (let i = msgCache.length - 1; i >= 0; i--) {
                if (msgCache[i].sender_id !== event.by) msgCache.splice(i, 1);
            }
            socketEmit('message_deleted', { all: true, by: event.by });
        } else if (event.t === 'typing') {
            if (event.from === myId) return;
            socketEmit('typing', event);
        }
    }

    function emitToUsers(userIds, event, payload) {
        for (const uid of new Set(userIds.filter(Boolean))) {
            publish(`${P()}/evt/dm/${uid}`, { t: event, ...(payload || {}) }, { retain: false });
        }
    }
    function emitToGroup(gid, event, payload) {
        publish(`${P()}/evt/group/${gid}`, { t: event, ...(payload || {}) }, { retain: false });
    }
    function broadcast(event, payload) {
        publish(`${P()}/evt/global`, { t: event, data: payload }, { retain: false });
    }

    /* ───────── سوکت مجازی (همان ظاهر socket.io) ───────── */

    const socketHandlers = new Map();
    function socketEmit(name, data) {
        const set = socketHandlers.get(name);
        if (!set) return;
        for (const fn of Array.from(set)) { try { fn(data); } catch (e) { console.warn('handler error', name, e); } }
    }

    function makeSocket() {
        const s = {
            connected: false,
            on(name, fn) {
                if (!socketHandlers.has(name)) socketHandlers.set(name, new Set());
                socketHandlers.get(name).add(fn);
                if (name === 'connect' && s.connected) setTimeout(() => fn(), 0);
                return s;
            },
            off(name, fn) { const set = socketHandlers.get(name); if (set) set.delete(fn); return s; },
            emit(name, data) {
                const self = me();
                if (!self) return s;
                if (name === 'join') {
                    /*
                     * صفحه با شنیدن «connect» یک «join» می‌فرستد. اگر اینجا دوباره
                     * «connect» بدهیم، حلقهٔ بی‌نهایت join→connect→join ساخته می‌شود
                     * و صفحه قفل می‌کند. پس «connect» فقط در گذار false→true داده
                     * می‌شود (یعنی یک‌بار، یا بعد از وصل‌شدن مجدد).
                     */
                    connect().then(() => {
                        publishPresence(true);
                        if (!s.connected) { s.connected = true; socketEmit('connect'); }
                    }).catch(err => { s.connected = false; socketEmit('connect_error', err); });
                } else if (name === 'typing') {
                    if (!data) return s;
                    const payload = { t: 'typing', from: Number(data.from), to: Number(data.to), scope: data.scope === 'group' ? 'group' : 'user', name: data.name || '' };
                    if (payload.scope === 'group') emitToGroupMembers(payload.to, payload);
                    else emitToUsers([payload.to], payload);
                } else if (name.indexOf('call_') === 0) {
                    /*
                     * call_offer / call_accept / call_reject / call_end / call_signal
                     * همه روی evt/call/<گیرنده> می‌روند (غیر retained = موقتی).
                     */
                    const t = name.slice(5);
                    const to = Number(data && data.to);
                    if (to) {
                        publish(`${P()}/evt/call/${to}`, Object.assign({ t, from: self.id, fromName: self.full_name }, data), { retain: false, qos: 1 });
                    }
                } else if (name === 'join_voice') {
                    if (data && data.room) voiceRooms.add(String(data.room));
                } else if (name === 'leave_voice') {
                    if (data && data.room) voiceRooms.delete(String(data.room));
                } else if (name === 'voice_signal') {
                    if (data && data.room) {
                        publish(`${P()}/evt/voice/${data.room}`, { sender: self.id, signal: data.signal || {} }, { retain: false });
                    }
                }
                return s;
            },
            disconnect() {
                publishPresence(false);
                s.connected = false;
                return s;
            }
        };
        /* کلاینت اول منتظر رویداد connect می‌ماند و بعد join می‌فرستد،
           پس اتصال را همین‌جا شروع می‌کنیم نه در join */
        connect()
            .then(() => { s.connected = true; socketEmit('connect'); })
            .catch(err => { s.connected = false; socketEmit('connect_error', err); });
        return s;
    }
    const voiceRooms = new Set();

    function emitToGroupMembers(gid, payload) {
        for (const m of prefixDocs('member')) {
            if (m.suffix.split('/')[0] === String(gid)) {
                const uid = Number(m.suffix.split('/')[1]);
                emitToUsers([uid], payload);
            }
        }
    }

    function groupMemberIds(gid) {
        return prefixDocs('member')
            .filter(m => m.suffix.split('/')[0] === String(gid))
            .map(m => Number(m.suffix.split('/')[1]));
    }
    function isGroupMember(gid, uid) {
        if (!uid) return false;
        const g = getDoc(`group/${gid}`);
        if (g && g.creator_id === uid) return true;
        return groupMemberIds(gid).includes(Number(uid));
    }

    /* ───────── اعلان‌ها ───────── */

    function localNotifications() { return readJSON(LS.notifs, []); }
    /**
     * ثبت اعلان در حافظهٔ گیرنده.
     * اعلان تکراریِ خوانده‌نشده (مثلاً لایک → برداشتن → لایک) ثبت نمی‌شود،
     * دقیقاً مثل رفتاری که نسخهٔ سروری داشت.
     * خروجی: true یعنی اعلان تازه ثبت شد.
     */
    function pushLocalNotification(n) {
        const list = localNotifications();
        if (list.some(x => x.id === n.id)) return false;
        const dup = list.some(x => !x.is_read && x.actor_id === n.actor_id && x.type === n.type
            && (x.post_id || 0) === (n.post_id || 0));
        if (dup) return false;
        list.unshift(n);
        writeJSON(LS.notifs, list.slice(0, 80));
        return true;
    }
    function notifyUser(userId, actorId, type, postId = null) {
        if (!userId || userId === actorId) return null;
        const actor = getDoc(`user/${actorId}`);
        const n = {
            id: newId(), user_id: userId, actor_id: actorId,
            actor_name: actor ? actor.full_name : 'کاربر',
            type, post_id: postId, is_read: false, timestamp: now()
        };
        publish(`${P()}/evt/notify/${userId}`, n, { retain: false });
        return n.id;
    }

    /* ───────── سریال‌سازی ───────── */

    function serializeUser(u) {
        return {
            id: u.id, username: u.username, full_name: u.full_name, bio: u.bio || '',
            avatar: u.avatar || null, role: u.role || 'user', created_at: u.created_at,
            is_online: isOnline(u.id)
        };
    }
    function allUsers() { return prefixDocs('user').map(d => d.value).sort((a, b) => a.id - b.id); }
    function findUser(id) { return getDoc(`user/${id}`) || null; }

    function serializePost(p, meId) {
        const likes = prefixDocs('like').filter(d => d.suffix.split('/')[0] === String(p.id)).length;
        const comments = prefixDocs('cmt').filter(d => d.suffix.split('/')[0] === String(p.id)).length;
        const views = prefixDocs('view').filter(d => d.suffix.split('/')[0] === String(p.id)).length;
        const author = findUser(p.user_id);
        return {
            id: p.id, user_id: p.user_id,
            full_name: author ? author.full_name : 'کاربر',
            username: author ? author.username : '',
            avatar: author ? author.avatar || null : null,
            content: p.content || '', file_path: p.media || null, file_name: p.file_name || null,
            file_type: p.file_type || null, views, timestamp: p.timestamp,
            likes_count: likes, comments_count: comments,
            liked_by_me: !!getDoc(`like/${p.id}/${meId}`),
            followed_by_me: !!getDoc(`follow/${meId}/${p.user_id}`)
        };
    }
    function allPosts(meId) {
        return prefixDocs('post')
            .map(d => serializePost(d.value, meId))
            .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : b.id - a.id));
    }

    function serializeMessage(m) {
        const reply = m.reply_to_id ? msgCache.find(x => x.id === m.reply_to_id) : null;
        const sender = findUser(m.sender_id);
        return {
            id: m.id, sender_id: m.sender_id,
            sender_name: sender ? sender.full_name : (m.sender_name || 'کاربر'),
            sender_username: sender ? sender.username : '',
            receiver_id: m.receiver_id || null, group_id: m.group_id || null,
            content: m.content || '', file_path: m.media || null,
            file_name: m.file_name || null, file_type: m.file_type || null,
            reply_to_id: m.reply_to_id || null,
            reply_content: reply ? reply.content || '' : (m.reply_content || ''),
            reply_file_name: reply ? reply.file_name || '' : (m.reply_file_name || ''),
            reply_sender_name: reply ? (findUser(reply.sender_id) || {}).full_name || '' : (m.reply_sender_name || ''),
            pinned: !!m.pinned, forwarded: !!m.forwarded, seen: !!m.seen,
            edited_at: m.edited_at || null, timestamp: m.timestamp
        };
    }

    function conversationMessages(meId, peerId) {
        return msgCache
            .filter(m => !m.group_id &&
                ((m.sender_id === meId && m.receiver_id === peerId) || (m.sender_id === peerId && m.receiver_id === meId)))
            .sort((a, b) => a.id - b.id)
            .map(serializeMessage);
    }
    function groupMessages(gid) {
        return msgCache.filter(m => m.group_id === gid).sort((a, b) => a.id - b.id).map(serializeMessage);
    }

    /* ───────── همسان‌سازی مخاطبین ───────── */

    /**
     * شماره را به شکل یکتا نرمال می‌کند: فقط رقم، با پیش‌شمارهٔ کشور.
     * شماره‌های ایران: ۰۹۱۲… → ۹۸۹۱۲…
     */
    function normalizePhone(raw) {
        let d = String(raw || '').replace(/\D/g, '');
        if (!d) return '';
        if (d.startsWith('00')) d = d.slice(2);
        if (d.length === 11 && d.startsWith('0')) d = '98' + d.slice(1);
        if (d.length === 10 && d.startsWith('9')) d = '98' + d;
        return d;
    }

    /** هش شماره تا شمارهٔ خام هیچ‌جا منتشر نشود */
    async function phoneHash(raw) {
        const d = normalizePhone(raw);
        if (!d) return '';
        return 'p' + (await sha256('jvl-phone:' + d)).slice(0, 24);
    }

    /* ───────── رسانه ───────── */

    /** رسانهٔ آمادهٔ نمایش: id → data URL */
    const mediaCache = new Map();
    /** انتقالهای در جریان: id → { n, mime, got, at } */
    const mediaParts = new Map();

    function putMedia(id, dataUrl) {
        mediaCache.set(id, dataUrl);
        /* حافظه بی‌نهایت نشود: قدیمی‌ترین‌ها دور ریخته شوند */
        while (mediaCache.size > MEDIA_CACHE_MAX) {
            const oldest = mediaCache.keys().next();
            if (oldest.done) break;
            mediaCache.delete(oldest.value);
        }
    }

    function sweepParts() {
        const t = Date.now();
        for (const [id, p] of mediaParts) if (t - p.at > PART_TTL_MS) mediaParts.delete(id);
    }

    /** یک تکه رسید؛ وقتی کامل شد data URL ساخته می‌شود */
    function receiveChunk(ev) {
        if (!ev || !ev.id || ev.from === (me() ? me().id : null)) return;
        sweepParts();
        let part = mediaParts.get(ev.id);
        if (!part) { part = { n: Number(ev.n) || 1, mime: ev.mime || 'application/octet-stream', got: new Map(), at: Date.now() }; mediaParts.set(ev.id, part); }
        part.at = Date.now();
        if (!part.got.has(ev.i)) part.got.set(ev.i, String(ev.d || ''));
        socketEmit('download_progress', { id: ev.id, got: part.got.size, total: part.n });
        if (part.got.size < part.n) return;
        let b64 = '';
        for (let i = 0; i < part.n; i++) b64 += part.got.get(i) || '';
        mediaParts.delete(ev.id);
        putMedia(String(ev.id), 'data:' + part.mime + ';base64,' + b64);
        /* صفحه گفتگو را دوباره رندر می‌کند تا جای «در حال دریافت» پر شود */
        socketEmit('message_updated', { media: String(ev.id) });
    }

    /**
     * رسانهٔ بزرگ را تکه‌تکه روی همان تاپیک رویدادها می‌فرستد.
     * غیر retained است، یعنی دقیقاً «موقتی»: فقط همان لحظه به گیرندهٔ آنلاین می‌رسد.
     */
    async function sendChunks(topics, id, dataUrl, mime) {
        const comma = dataUrl.indexOf(',');
        const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
        const n = Math.max(1, Math.ceil(b64.length / Config.chunkText));
        for (let i = 0; i < n; i++) {
            const d = b64.slice(i * Config.chunkText, (i + 1) * Config.chunkText);
            for (const t of topics) publish(t, { t: 'chunk', id: String(id), from: me().id, i, n, mime, d }, { retain: false, qos: 1 });
            socketEmit('upload_progress', { id: String(id), sent: i + 1, total: n });
            /* هر چند تکه یک‌بار حلقهٔ رویداد را آزاد کن تا UI قفل نشود */
            if (i % 6 === 5) await new Promise(r => setTimeout(r, 0));
        }
        return n;
    }

    /** شناسهٔ یکتای رسانه + ثبت فوری در کش خودمان (سمت فرستنده) */
    function beginStream(dataUrl, mime) {
        const id = 'm' + newId().toString(36) + Math.random().toString(36).slice(2, 6);
        putMedia(id, dataUrl);
        return { id, mime };
    }

    /** فایل → data URL فشرده (چون هیچ دیسکی در کار نیست) */
    function fileToMedia(file, opts = {}) {
        return new Promise((resolve, reject) => {
            if (!file) return reject(new Error('فایلی انتخاب نشده'));
            const type = (file.type || '').toLowerCase();
            const ext = (file.name.split('.').pop() || '').toLowerCase();
            const isImage = type.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext);
            const isAudio = type.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a', 'webm', 'weba', 'opus'].includes(ext);
            const isVideo = type.startsWith('video/') || ['mp4', 'mkv', 'mov', 'avi', 'flv', '3gp'].includes(ext);

            const kind = isImage ? 'image' : (isVideo ? 'video' : (isAudio ? 'audio' : null));
            if (!kind) return reject(new Error('در حالت MQTT فقط عکس، صوت و ویدیو'));
            /* ویدیو و فایل‌های بزرگ فقط در چت و به‌صورت تکه‌تکه */
            const canStream = !!opts.allowStream;
            if (!isImage && !canStream) {
                return reject(new Error(kind === 'video'
                    ? 'ویدیو فقط در چت ارسال می‌شود (برای استوری و پست عکس بفرست)'
                    : 'در این بخش فقط عکس می‌شود فرستاد'));
            }
            if (file.size > Config.streamLimit) {
                return reject(new Error(`حجم فایل بیشتر از ${(Config.streamLimit / 1048576).toFixed(0)}MB است`));
            }

            const reader = new FileReader();
            reader.onerror = () => reject(new Error('خواندن فایل ناموفق بود'));
            reader.onload = () => {
                const dataUrl = String(reader.result);
                if (dataUrl.length <= Config.mediaLimit * 1.4) {
                    return resolve({ media: dataUrl, file_type: kind, compressed: false, stream: false, mime: type || mimeOf(kind, ext) });
                }
                if (canStream) {
                    /* ویدیو و صوت/عکس بزرگ: دست‌نخورده، ولی تکه‌تکه فرستاده می‌شود */
                    return resolve({ media: dataUrl, file_type: kind, compressed: false, stream: true, mime: type || mimeOf(kind, ext) });
                }
                if (!isImage) return reject(new Error(`صوت بزرگ‌تر از ${(Config.mediaLimit / 1024).toFixed(0)}KB است — کوتاه‌تر ضبط کن`));
                compressImageTo(dataUrl, Config.mediaLimit)
                    .then(out => resolve({ media: out, file_type: 'image', compressed: true, stream: false, mime: 'image/jpeg' }))
                    .catch(() => reject(new Error('فشرده‌سازی عکس ناموفق بود')));
            };
            reader.readAsDataURL(file);
        });
    }

    function mimeOf(kind, ext) {
        if (kind === 'image') return 'image/jpeg';
        if (kind === 'video') return ext === 'webm' ? 'video/webm' : 'video/mp4';
        return ext === 'ogg' || ext === 'opus' ? 'audio/ogg' : (ext === 'wav' ? 'audio/wav' : 'audio/mpeg');
    }

    function compressImageTo(dataUrl, targetBytes) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onerror = () => reject(new Error('image load'));
            img.onload = () => {
                let w = img.width, h = img.height;
                const attempt = (dim, quality) => {
                    const r = Math.min(1, dim / Math.max(w, h));
                    const cw = Math.max(1, Math.round(w * r)), ch = Math.max(1, Math.round(h * r));
                    const c = document.createElement('canvas');
                    c.width = cw; c.height = ch;
                    c.getContext('2d').drawImage(img, 0, 0, cw, ch);
                    return c.toDataURL('image/jpeg', quality);
                };
                let out = attempt(1280, 0.7);
                for (const [dim, q] of [[960, 0.6], [720, 0.5], [520, 0.45], [380, 0.4]]) {
                    if (out.length <= targetBytes * 1.4) break;
                    out = attempt(dim, q);
                }
                if (out.length > targetBytes * 1.9) return reject(new Error('too big'));
                resolve(out);
            };
            img.src = dataUrl;
        });
    }

    /* ───────── جدول مسیرها (جایگزین Express) ───────── */

    const ok = (body, status = 200) => ({ status, body });
    const err = (message, status = 400) => ({ status, body: { success: false, message } });
    const needAuth = () => (me() ? null : err('وارد نشده‌ای', 401));

    const routes = [];
    function route(method, pattern, handler) {
        const keys = [];
        const re = new RegExp('^' + pattern.replace(/:[a-z_]+/gi, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
        routes.push({ method, source: pattern, re, keys, handler });
    }

    /* ── احراز هویت ── */
    route('POST', '/register', async (p, body) => {
        const username = String((body && body.username) || '').trim();
        const password = String((body && body.password) || '');
        if (!/^[a-zA-Z0-9_.]{3,32}$/.test(username)) return err('نام کاربری باید ۳ تا ۳۲ کاراکتر انگلیسی باشد');
        if (password.length < 4) return err('رمز عبور حداقل ۴ کاراکتر باشد');
        await connect();
        const key = username.toLowerCase();
        if (getDoc(`uname/${key}`)) return err('این نام کاربری قبلاً گرفته شده');

        const id = newId();
        const salt = Math.random().toString(16).slice(2, 10);
        const user = {
            id, username, full_name: username, bio: '', avatar: null,
            role: allUsers().length === 0 ? 'admin' : 'user',
            created_at: now(), salt, pass: await sha256(salt + password)
        };
        publish(`${P()}/user/${id}`, user);
        publish(`${P()}/uname/${key}`, { id });
        return ok({
            success: true,
            message: user.role === 'admin' ? 'حساب ساخته شد — تو اولین مدیر این شبکه‌ای 👑' : 'حساب ساخته شد ✅ حالا وارد شو',
            user: serializeUser(user)
        });
    });

    route('POST', '/login', async (p, body) => {
        const username = String((body && body.username) || '').trim().toLowerCase();
        const password = String((body && body.password) || '');
        await connect();
        const ref = getDoc(`uname/${username}`);
        const user = ref ? getDoc(`user/${ref.id}`) : null;
        if (!user) return err('نام کاربری یا رمز عبور اشتباه است', 401);
        const hash = await sha256((user.salt || '') + password);
        if (hash !== user.pass) return err('نام کاربری یا رمز عبور اشتباه است', 401);
        return ok({ success: true, user: serializeUser(user), token: `jvl.${user.id}.${hash.slice(0, 12)}` });
    });

    /* ── متا ── */
    route('GET', '/api/app_info', () => ok({
        name: Config.appName, version: Config.appVersion, transport: 'mqtt',
        broker: Config.broker, network: Config.networkKey,
        limits: { image: Config.mediaLimit, video: Config.streamLimit, file: Config.streamLimit },
        capabilities: { calls: true, contacts: true, pwa: true },
        story_ttl_hours: Config.storyTtlHours
    }));
    route('GET', '/api/health', () => ok({ ok: true, version: Config.appVersion, transport: 'mqtt', connected: ready }));

    /* ── کاربران ── */
    route('GET', '/users', async () => {
        const e = needAuth(); if (e) return e;
        await connect();
        return ok(allUsers().map(serializeUser));
    });

    route('GET', '/unread_counts/:me', async p => {
        const e = needAuth(); if (e) return e;
        const myId = me().id;
        const out = {};
        for (const m of msgCache) {
            if (m.receiver_id === myId && m.sender_id !== myId && !m.seen) {
                out[m.sender_id] = (out[m.sender_id] || 0) + 1;
            }
        }
        return ok(out);
    });

    route('GET', '/user_profile/:me/:uid', async p => {
        const e = needAuth(); if (e) return e;
        const uid = Number(p.uid), myId = me().id;
        const u = findUser(uid);
        if (!u) return err('کاربر پیدا نشد', 404);
        return ok({
            id: u.id, username: u.username, full_name: u.full_name, bio: u.bio || '',
            avatar: u.avatar || null, role: u.role, created_at: u.created_at, is_online: isOnline(uid),
            posts_count: allPosts(myId).filter(x => x.user_id === uid).length,
            followers: prefixDocs('follow').filter(d => d.suffix.split('/')[1] === String(uid)).length,
            following_count: prefixDocs('follow').filter(d => d.suffix.split('/')[0] === String(uid)).length,
            is_following: myId !== uid && !!getDoc(`follow/${myId}/${uid}`)
        });
    });

    route('POST', '/follow/:uid', async p => {
        const e = needAuth(); if (e) return e;
        const myId = me().id, uid = Number(p.uid);
        if (uid === myId) return err('نمی‌توانی خودت را دنبال کنی');
        if (!findUser(uid)) return err('کاربر پیدا نشد', 404);
        const existing = !!getDoc(`follow/${myId}/${uid}`);
        if (existing) publish(`${P()}/follow/${myId}/${uid}`, null);
        else { publish(`${P()}/follow/${myId}/${uid}`, { at: now() }); notifyUser(uid, myId, 'follow', null); }
        broadcast('follow_update', { target_id: uid, follower_id: myId, following: !existing });
        return ok({ success: true, following: !existing });
    });

    route('GET', '/notifications/:uid', () => {
        const e = needAuth(); if (e) return e;
        const items = localNotifications();
        return ok({ unread: items.filter(n => !n.is_read).length, items });
    });
    route('POST', '/notifications_read/:uid', () => {
        const e = needAuth(); if (e) return e;
        writeJSON(LS.notifs, localNotifications().map(n => ({ ...n, is_read: true })));
        return ok({ success: true });
    });

    /* ── چت ── */
    route('GET', '/messages/:me/:peer', async p => {
        const e = needAuth(); if (e) return e;
        const myId = me().id, peer = Number(p.peer);
        for (const m of msgCache) {
            if (m.sender_id === peer && m.receiver_id === myId) m.seen = true;
        }
        return ok(conversationMessages(myId, peer));
    });

    route('GET', '/group_messages/:gid', async p => {
        const e = needAuth(); if (e) return e;
        const gid = Number(p.gid), myId = me().id;
        if (!isGroupMember(gid, myId)) return err('عضو این گروه نیستی', 403);
        const reads = readJSON(LS.groupRead, {});
        reads[gid] = now();
        writeJSON(LS.groupRead, reads);
        return ok(groupMessages(gid));
    });

    route('POST', '/send_message', async (p, body, meta) => {
        const e = needAuth(); if (e) return e;
        const self = me();
        const content = String((body && body.content) || '').trim();
        const groupId = body && body.group_id ? Number(body.group_id) : null;
        const receiverId = body && body.receiver_id ? Number(body.receiver_id) : null;
        const replyToId = body && body.reply_to_id ? Number(body.reply_to_id) : null;

        let media = null, fileType = null, fileName = null;
        let rawMedia = null, streamInfo = null;
        const file = meta && meta.file;
        if (file) {
            try {
                /* چت تنها جایی است که رسانهٔ بزرگ/ویدیو به‌صورت تکه‌تکه می‌رود */
                const out = await fileToMedia(file, { allowStream: true });
                fileType = out.file_type; fileName = file.name || null;
                if (out.stream) {
                    streamInfo = beginStream(out.media, out.mime);
                    rawMedia = out.media;
                    media = 'media:' + streamInfo.id;   /* ارجاع، نه خودِ داده */
                } else {
                    media = out.media;
                }
            } catch (ex) { return err(ex.message || 'ارسال فایل ناموفق بود'); }
        }
        if (!content && !media) return err('پیام خالی است');

        if (groupId) {
            if (!isGroupMember(groupId, self.id)) return err('عضو این گروه نیستی', 403);
        } else if (receiverId) {
            if (receiverId === self.id) return err('نمی‌توانی به خودت پیام بدهی');
            if (!findUser(receiverId)) return err('گیرنده پیدا نشد', 404);
        } else return err('مقصد پیام مشخص نیست');

        const m = {
            id: newId(), sender_id: self.id, receiver_id: groupId ? null : receiverId,
            group_id: groupId, content, media, file_type: fileType, file_name: fileName,
            reply_to_id: replyToId || null, pinned: false, forwarded: false, seen: false, timestamp: now()
        };
        msgCache.push(m);
        const payload = { m };
        if (groupId) emitToGroup(groupId, 'msg', payload);
        else emitToUsers([receiverId, self.id], 'msg', payload);
        socketEmit('new_message', serializeMessage(m));

        /* اول پیام می‌رسد (با جای خالی رسانه)، بعد تکه‌ها یکی‌یکی */
        if (streamInfo) {
            const topics = groupId ? [`${P()}/evt/group/${groupId}`] : [`${P()}/evt/dm/${receiverId}`];
            sendChunks(topics, streamInfo.id, rawMedia, streamInfo.mime).catch(() => { /* ignore */ });
        }
        return ok({ success: true, message: serializeMessage(m) });
    });

    /**
     * شمارهٔ کاربر را (به‌صورت هش) ثبت می‌کند تا دیگران بتوانند از روی
     * مخاطبین گوشی پیدایش کنند. خودِ شماره هرگز منتشر نمی‌شود.
     */
    route('POST', '/set_phone', async (p, body) => {
        const e = needAuth(); if (e) return e;
        const self = me();
        const hash = await phoneHash((body && body.phone) || '');
        if (!hash) return err('شماره معتبر نیست');
        const prev = getDoc(`phone/${hash}`);
        if (prev && prev.id !== self.id) return err('این شماره به حساب دیگری وصل است', 409);
        publish(`${P()}/phone/${hash}`, { id: self.id, at: now() });
        const u = getDoc(`user/${self.id}`) || self;
        publish(`${P()}/user/${self.id}`, Object.assign({}, u, { has_phone: true }));
        return ok({ success: true });
    });

    /**
     * فهرست هشِ شماره‌های مخاطبین را می‌گیرد و آن‌هایی که روی پلتفرم هستند
     * را برمی‌گرداند. همه‌چیز سمت کلاینت می‌ماند؛ فقط هش‌ها روی MQTT می‌روند.
     */
    route('POST', '/contacts_lookup', async (p, body) => {
        const e = needAuth(); if (e) return e;
        const hashes = Array.isArray(body && body.hashes) ? body.hashes.slice(0, 2000) : [];
        const found = [];
        for (const h of hashes) {
            const key = String(h).startsWith('p') ? String(h) : await phoneHash(h);
            const ref = key ? getDoc(`phone/${key}`) : null;
            if (!ref) continue;
            const u = findUser(ref.id);
            if (!u || u.id === me().id) continue;
            found.push({ hash: key, id: u.id, username: u.username, full_name: u.full_name, avatar: u.avatar || null, is_online: isOnline(u.id) });
        }
        return ok({ matches: found, checked: hashes.length });
    });

    /** شمارهٔ خام → هش، برای وقتی که صفحه می‌خواهد خودش lookup بفرستد */
    route('POST', '/phone_hash', async (p, body) => {
        const e = needAuth(); if (e) return e;
        const h = await phoneHash((body && body.phone) || '');
        if (!h) return err('شماره معتبر نیست');
        return ok({ hash: h });
    });

    route('POST', '/seen_messages/:sender', async p => {
        const e = needAuth(); if (e) return e;
        const myId = me().id, sender = Number(p.sender);
        let n = 0;
        for (const m of msgCache) if (m.sender_id === sender && m.receiver_id === myId && !m.seen) { m.seen = true; n++; }
        /* بدون تغییر وضعیت، هیچ انتشاری — وگرنه هر loadMessages یک دور حلقه می‌سازد */
        if (n === 0) return ok({ success: true, updated: 0 });
        const payload = { by: myId, partner: sender, count: n };
        emitToUsers([sender, myId], 'seen', payload);
        socketEmit('messages_seen', { by: myId, partner: sender });
        return ok({ success: true, updated: n });
    });

    route('POST', '/pin_message/:mid', async p => {
        const e = needAuth(); if (e) return e;
        const self = me(), mid = Number(p.mid);
        const m = msgCache.find(x => x.id === mid);
        if (!m) return err('پیام پیدا نشد (در حالت MQTT فقط پیام‌های همین نشست در حافظه‌اند)', 404);
        if (m.sender_id !== self.id && m.receiver_id !== self.id && self.role !== 'admin') return err('اجازهٔ این کار را نداری', 403);

        const scope = m.group_id ? `g-${m.group_id}` : `u-${Math.min(m.sender_id, m.receiver_id)}-${Math.max(m.sender_id, m.receiver_id)}`;
        const current = getDoc(`pin/${scope}`);
        const pinned = !(current && current.message_id === mid);
        msgCache.forEach(x => {
            const sameScope = m.group_id ? x.group_id === m.group_id
                : !x.group_id && ((x.sender_id === m.sender_id && x.receiver_id === m.receiver_id) || (x.sender_id === m.receiver_id && x.receiver_id === m.sender_id));
            if (sameScope) x.pinned = false;
        });
        if (pinned) {
            m.pinned = true;
            publish(`${P()}/pin/${scope}`, { message_id: mid, at: now() });
        } else publish(`${P()}/pin/${scope}`, null);

        if (m.group_id) emitToGroup(m.group_id, 'pin', { message_id: mid, pinned });
        else emitToUsers([m.sender_id, m.receiver_id], 'pin', { message_id: mid, pinned });
        socketEmit('messages_pin', { message_id: mid, pinned });
        return ok({ success: true, pinned });
    });

    route('POST', '/edit_message', async (p, body) => {
        const e = needAuth(); if (e) return e;
        const self = me();
        const mid = Number(body && body.message_id);
        const content = String((body && body.content) || '').trim();
        const m = msgCache.find(x => x.id === mid);
        if (!m) return err('پیام پیدا نشد', 404);
        if (m.sender_id !== self.id) return err('فقط نویسندهٔ پیام می‌تواند ویرایش کند', 403);
        if (!content) return err('متن جدید خالی است');
        m.content = content; m.edited_at = now();
        const payload = { message_id: mid, content, edited_at: m.edited_at };
        if (m.group_id) emitToGroup(m.group_id, 'edit', payload);
        else emitToUsers([m.sender_id, m.receiver_id], 'edit', payload);
        socketEmit('message_updated', { message_id: mid });
        return ok({ success: true, message: serializeMessage(m) });
    });

    route('DELETE', '/delete_message/:mid', async p => {
        const e = needAuth(); if (e) return e;
        const self = me(), mid = Number(p.mid);
        const i = msgCache.findIndex(x => x.id === mid);
        if (i < 0) return err('پیام پیدا نشد', 404);
        const m = msgCache[i];
        if (m.sender_id !== self.id && self.role !== 'admin') return err('فقط نویسنده یا مدیر می‌تواند حذف کند', 403);
        msgCache.splice(i, 1);
        const payload = { message_id: mid };
        if (m.group_id) emitToGroup(m.group_id, 'delete', payload);
        else emitToUsers([m.sender_id, m.receiver_id], 'delete', payload);
        socketEmit('message_deleted', payload);
        return ok({ success: true });
    });

    route('POST', '/forward_message', async (p, body) => {
        const e = needAuth(); if (e) return e;
        const self = me();
        const src = msgCache.find(x => x.id === Number(body && body.message_id));
        if (!src) return err('پیام پیدا نشد', 404);
        const targets = Array.isArray(body.targets) ? body.targets : [];
        let sent = 0;
        for (const t of targets) {
            const id = Number(t && t.id);
            if (!id) continue;
            let receiverId = null, groupId = null;
            if (t.type === 'group') {
                if (!isGroupMember(id, self.id)) continue;
                groupId = id;
            } else {
                if (id === self.id || !findUser(id)) continue;
                receiverId = id;
            }
            const copy = {
                id: newId(), sender_id: self.id, receiver_id: receiverId, group_id: groupId,
                content: src.content, media: src.media, file_type: src.file_type, file_name: src.file_name,
                reply_to_id: null, pinned: false, forwarded: true, seen: false, timestamp: now()
            };
            msgCache.push(copy);
            const payload = { m: copy };
            if (groupId) emitToGroup(groupId, 'msg', payload);
            else emitToUsers([receiverId, self.id], 'msg', payload);
            socketEmit('new_message', serializeMessage(copy));
            sent++;
        }
        return ok({ success: true, sent });
    });

    /* ── گروه‌ها ── */
    route('GET', '/my_groups', async () => {
        const e = needAuth(); if (e) return e;
        const myId = me().id;
        const reads = readJSON(LS.groupRead, {});
        const groups = prefixDocs('group').map(d => d.value).filter(g => isGroupMember(g.id, myId));
        return ok(groups.map(g => {
            const msgs = msgCache.filter(m => m.group_id === g.id);
            const readAt = reads[g.id];
            const last = msgs[msgs.length - 1];
            return {
                id: g.id, name: g.name, creator_id: g.creator_id, created_at: g.created_at,
                my_role: g.creator_id === myId ? 'owner' : 'member',
                members_count: groupMemberIds(g.id).length,
                unread: msgs.filter(m => m.sender_id !== myId && (!readAt || m.timestamp > readAt)).length,
                last_content: last ? last.content || '' : '',
                last_file: last ? last.file_name || '' : ''
            };
        }).sort((a, b) => b.id - a.id));
    });

    route('POST', '/create_group', async (p, body) => {
        const e = needAuth(); if (e) return e;
        const self = me();
        const name = String((body && body.name) || '').trim();
        if (!name) return err('نام گروه را بنویس');
        if (name.length > 60) return err('نام گروه خیلی بلند است');
        const gid = newId();
        publish(`${P()}/group/${gid}`, { id: gid, name, creator_id: self.id, created_at: now() });
        publish(`${P()}/member/${gid}/${self.id}`, { role: 'owner', joined_at: now() });
        const members = [self.id];
        for (const uid of (Array.isArray(body.members) ? body.members : []).map(Number).filter(Boolean)) {
            if (uid === self.id || !findUser(uid)) continue;
            publish(`${P()}/member/${gid}/${uid}`, { role: 'member', joined_at: now() });
            members.push(uid);
        }
        broadcast('groups_changed', { group_id: gid });
        socketEmit('groups_changed', { group_id: gid });
        return ok({ success: true, message: `گروه «${name}» ساخته شد 👥`, group_id: gid });
    });

    route('GET', '/group_info/:gid', async p => {
        const e = needAuth(); if (e) return e;
        const gid = Number(p.gid), myId = me().id;
        const g = getDoc(`group/${gid}`);
        if (!g) return err('گروه پیدا نشد', 404);
        if (!isGroupMember(gid, myId)) return err('عضو این گروه نیستی', 403);
        const ids = groupMemberIds(gid);
        if (!ids.includes(g.creator_id)) ids.push(g.creator_id);
        const members = ids.map(id => findUser(id)).filter(Boolean).map(u => ({
            ...serializeUser(u), role: u.id === g.creator_id ? 'owner' : 'member'
        })).sort((a, b) => (a.role === b.role ? 0 : a.role === 'owner' ? -1 : 1));
        return ok({ success: true, group: { id: g.id, name: g.name, creator_id: g.creator_id, created_at: g.created_at }, members });
    });

    route('POST', '/group_add_member/:gid', async (p, body) => {
        const e = needAuth(); if (e) return e;
        const self = me(), gid = Number(p.gid), uid = Number(body && body.user_id);
        const g = getDoc(`group/${gid}`);
        if (!g) return err('گروه پیدا نشد', 404);
        if (g.creator_id !== self.id && self.role !== 'admin') return err('فقط مالک گروه می‌تواند عضو اضافه کند', 403);
        if (!findUser(uid)) return err('کاربر پیدا نشد', 404);
        if (groupMemberIds(gid).includes(uid)) return err('این کاربر قبلاً عضو است');
        publish(`${P()}/member/${gid}/${uid}`, { role: 'member', joined_at: now() });
        broadcast('groups_changed', { group_id: gid });
        socketEmit('groups_changed', { group_id: gid });
        return ok({ success: true, message: 'عضو اضافه شد' });
    });

    route('POST', '/group_remove_member/:gid', async (p, body) => {
        const e = needAuth(); if (e) return e;
        const self = me(), gid = Number(p.gid), uid = Number(body && body.user_id);
        const g = getDoc(`group/${gid}`);
        if (!g) return err('گروه پیدا نشد', 404);
        const isSelf = uid === self.id;
        if (!isSelf && g.creator_id !== self.id && self.role !== 'admin') return err('فقط مالک گروه می‌تواند عضو را حذف کند', 403);
        if (uid === g.creator_id && !isSelf) return err('مالک گروه را نمی‌شود حذف کرد');
        publish(`${P()}/member/${gid}/${uid}`, null);
        const rest = groupMemberIds(gid);
        if (!rest.length) publish(`${P()}/group/${gid}`, null);
        broadcast('groups_changed', { group_id: gid });
        socketEmit('groups_changed', { group_id: gid });
        return ok({ success: true, message: isSelf ? 'از گروه خارج شدی' : 'عضو حذف شد' });
    });

    route('DELETE', '/group_delete/:gid', async p => {
        const e = needAuth(); if (e) return e;
        const self = me(), gid = Number(p.gid);
        const g = getDoc(`group/${gid}`);
        if (!g) return err('گروه پیدا نشد', 404);
        if (g.creator_id !== self.id && self.role !== 'admin') return err('فقط مالک گروه یا مدیر می‌تواند حذف کند', 403);
        for (const uid of groupMemberIds(gid)) publish(`${P()}/member/${gid}/${uid}`, null);
        publish(`${P()}/group/${gid}`, null);
        for (let i = msgCache.length - 1; i >= 0; i--) if (msgCache[i].group_id === gid) msgCache.splice(i, 1);
        broadcast('groups_changed', { group_id: gid });
        socketEmit('groups_changed', { group_id: gid });
        return ok({ success: true, message: 'گروه حذف شد' });
    });

    /* ── اکسپلور ── */
    route('GET', '/posts', async () => {
        const e = needAuth(); if (e) return e;
        await connect();
        return ok(allPosts(me().id));
    });

    route('POST', '/create_post', async (p, body, meta) => {
        const e = needAuth(); if (e) return e;
        const self = me();
        const content = String((body && body.content) || '').trim();
        let media = null, fileType = null, fileName = null;
        const file = meta && meta.file;
        if (file) {
            try {
                const out = await fileToMedia(file);
                media = out.media; fileType = out.file_type; fileName = file.name || null;
            } catch (ex) { return err(ex.message || 'انتشار ناموفق بود'); }
        }
        if (!content && !media) return err('متن بنویس یا فایل انتخاب کن');
        const id = newId();
        const post = { id, user_id: self.id, content, media, file_type: fileType, file_name: fileName, timestamp: now() };
        publish(`${P()}/post/${id}`, post);
        return ok({ success: true, post: serializePost(post, self.id) });
    });

    route('POST', '/like_post/:pid', async p => {
        const e = needAuth(); if (e) return e;
        const self = me(), pid = Number(p.pid);
        if (!getDoc(`post/${pid}`)) return err('پست پیدا نشد', 404);
        const liked = !getDoc(`like/${pid}/${self.id}`);
        if (liked) { publish(`${P()}/like/${pid}/${self.id}`, { at: now() }); notifyUser(getDoc(`post/${pid}`).user_id, self.id, 'like', pid); }
        else publish(`${P()}/like/${pid}/${self.id}`, null);
        const likes_count = prefixDocs('like').filter(d => d.suffix.split('/')[0] === String(pid)).length;
        broadcast('post_like', { post_id: pid, likes_count, liked, user_id: self.id });
        socketEmit('post_like', { post_id: pid, likes_count });
        return ok({ success: true, liked, likes_count });
    });

    route('POST', '/view_post/:pid', async p => {
        const e = needAuth(); if (e) return e;
        const self = me(), pid = Number(p.pid);
        if (!getDoc(`post/${pid}`)) return err('پست پیدا نشد', 404);
        publish(`${P()}/view/${pid}/${self.id}`, { at: now() });
        const history = readJSON(LS.history, []);
        if (!history.includes(pid)) { history.unshift(pid); writeJSON(LS.history, history.slice(0, 100)); }
        const views = prefixDocs('view').filter(d => d.suffix.split('/')[0] === String(pid)).length;
        broadcast('post_view', { post_id: pid, views });
        socketEmit('post_view', { post_id: pid, views });
        return ok({ success: true, views });
    });

    route('GET', '/post_comments/:pid', async p => {
        const e = needAuth(); if (e) return e;
        const pid = String(p.pid);
        const list = prefixDocs('cmt').filter(d => d.suffix.split('/')[0] === pid).map(d => d.value);
        return ok(list.sort((a, b) => a.id - b.id).map(c => {
            const u = findUser(c.user_id);
            return {
                id: c.id, user_id: c.user_id, full_name: u ? u.full_name : 'کاربر',
                username: u ? u.username : '', avatar: u ? u.avatar || null : null,
                content: c.content, timestamp: c.timestamp
            };
        }));
    });

    route('POST', '/comment_post/:pid', async (p, body) => {
        const e = needAuth(); if (e) return e;
        const self = me(), pid = Number(p.pid);
        const content = String((body && body.content) || '').trim();
        if (!content) return err('متن نظر خالی است');
        const post = getDoc(`post/${pid}`);
        if (!post) return err('پست پیدا نشد', 404);
        const id = newId();
        publish(`${P()}/cmt/${pid}/${id}`, { id, user_id: self.id, content, timestamp: now() });
        notifyUser(post.user_id, self.id, 'comment', pid);
        const comments_count = prefixDocs('cmt').filter(d => d.suffix.split('/')[0] === String(pid)).length;
        broadcast('post_comment', { post_id: pid, comments_count, user_id: self.id });
        socketEmit('post_comment', { post_id: pid, comments_count });
        return ok({ success: true, comment_id: id, comments_count });
    });

    route('GET', '/history/:uid', async () => {
        const e = needAuth(); if (e) return e;
        const ids = readJSON(LS.history, []);
        const mine = me().id;
        return ok(ids.map(id => getDoc(`post/${id}`)).filter(Boolean).map(p => serializePost(p, mine)));
    });

    route('GET', '/stories', async () => {
        const e = needAuth(); if (e) return e;
        const mine = me().id, t = now();
        return ok(prefixDocs('story').map(d => d.value)
            .filter(s => s.expires_at > t)
            .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
            .map(s => {
                const u = findUser(s.user_id);
                return {
                    id: s.id, user_id: s.user_id, full_name: u ? u.full_name : 'کاربر',
                    username: u ? u.username : '', avatar: u ? u.avatar || null : null,
                    file_path: s.media, file_type: s.file_type, created_at: s.created_at, expires_at: s.expires_at,
                    viewed_by_me: !!getDoc(`sview/${s.id}/${mine}`)
                };
            }));
    });

    route('POST', '/create_story', async (p, body, meta) => {
        const e = needAuth(); if (e) return e;
        const self = me();
        const file = meta && meta.file;
        if (!file) return err('یک عکس یا ویدیو انتخاب کن');
        let out;
        try { out = await fileToMedia(file); } catch (ex) { return err(ex.message); }
        if (out.file_type !== 'image') return err('در حالت MQTT فقط عکس برای استوری');
        const id = newId(), created = now();
        publish(`${P()}/story/${id}`, {
            id, user_id: self.id, media: out.media, file_type: 'image',
            created_at: created, expires_at: plusHours(Config.storyTtlHours)
        });
        return ok({ success: true, story_id: id, expires_at: plusHours(Config.storyTtlHours) });
    });

    route('POST', '/view_story/:sid', async p => {
        const e = needAuth(); if (e) return e;
        const sid = Number(p.sid);
        if (!getDoc(`story/${sid}`)) return err('استوری پیدا نشد', 404);
        publish(`${P()}/sview/${sid}/${me().id}`, { at: now() });
        return ok({ success: true });
    });

    route('GET', '/story_views/:sid', async p => {
        const e = needAuth(); if (e) return e;
        const self = me(), sid = String(p.sid);
        const story = getDoc(`story/${sid}`);
        if (!story) return err('استوری پیدا نشد', 404);
        if (story.user_id !== self.id && self.role !== 'admin') return err('فقط صاحب استوری بیننده‌ها را می‌بیند', 403);
        const viewers = prefixDocs('sview')
            .filter(d => d.suffix.split('/')[0] === sid && Number(d.suffix.split('/')[1]) !== story.user_id)
            .map(d => findUser(Number(d.suffix.split('/')[1])))
            .filter(Boolean)
            .map(u => ({ id: u.id, full_name: u.full_name, username: u.username, avatar: u.avatar || null }));
        return ok({ success: true, viewers });
    });

    /* ── LAN ── */
    route('GET', '/lan_hosts', async () => {
        const e = needAuth(); if (e) return e;
        return ok(prefixDocs('lan').map(d => d.value).sort((a, b) => b.id - a.id).map(h => {
            const u = findUser(h.user_id);
            return {
                id: h.id, user_id: h.user_id, full_name: u ? u.full_name : 'کاربر',
                username: u ? u.username : '', game_name: h.game_name, ip_address: h.ip_address,
                port: h.port, description: h.description || '', created_at: h.created_at
            };
        }));
    });

    route('POST', '/create_lan_host', async (p, body) => {
        const e = needAuth(); if (e) return e;
        const self = me();
        const game_name = String((body && body.game_name) || '').trim();
        const ip_address = String((body && body.ip_address) || '').trim();
        const port = String((body && body.port) || '').trim();
        const description = String((body && body.description) || '').trim();
        if (!game_name || !ip_address || !port) return err('نام بازی، IP و پورت را پر کن');
        const looksLikeIp = /^[0-9.]+$/.test(ip_address);
        const validIp = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip_address) && ip_address.split('.').every(x => Number(x) <= 255);
        if (looksLikeIp ? !validIp : !/^[a-zA-Z0-9._-]+$/.test(ip_address)) return err('آدرس IP یا نام میزبان معتبر نیست');
        const portNum = Number(port);
        if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return err('پورت باید عددی بین ۱ تا ۶۵۵۳۵ باشد');
        const id = newId();
        publish(`${P()}/lan/${id}`, { id, user_id: self.id, game_name, ip_address, port: String(portNum), description: description.slice(0, 300), created_at: now() });
        return ok({ success: true, id });
    });

    route('DELETE', '/delete_lan_host/:id', async p => {
        const e = needAuth(); if (e) return e;
        const self = me(), id = Number(p.id);
        const h = getDoc(`lan/${id}`);
        if (!h) return err('هاست پیدا نشد', 404);
        if (h.user_id !== self.id && self.role !== 'admin') return err('فقط سازنده یا مدیر می‌تواند حذف کند', 403);
        publish(`${P()}/lan/${id}`, null);
        return ok({ success: true });
    });

    /* ── پروفایل ── */
    route('POST', '/update_profile', async (p, body, meta) => {
        const e = needAuth(); if (e) return e;
        const self = me();
        const full_name = String((body && body.full_name) || '').trim();
        const bio = String((body && body.bio) || '').trim();
        if (!full_name) return err('نام نمایشی را بنویس');
        if (full_name.length > 60) return err('نام نمایشی خیلی بلند است');
        if (bio.length > 300) return err('بیوگرافی خیلی بلند است');
        let avatar = self.avatar || null;
        const file = meta && meta.file;
        if (file) {
            try { const out = await fileToMedia(file); avatar = out.media; }
            catch (ex) { return err(ex.message); }
        }
        const current = findUser(self.id);
        if (!current) return err('کاربر پیدا نشد — یک بار دیگر وارد شو', 404);
        const updated = { ...current, full_name, bio, avatar };
        publish(`${P()}/user/${self.id}`, updated);
        const pub = serializeUser(updated);
        store.setItem(LS.user, JSON.stringify(pub));
        return ok({ success: true, user: pub });
    });

    route('POST', '/change_password', async (p, body) => {
        const e = needAuth(); if (e) return e;
        const self = me();
        const oldPassword = String((body && body.old_password) || '');
        const newPassword = String((body && body.new_password) || '');
        const doc = findUser(self.id);
        if (!doc) return err('کاربر پیدا نشد', 404);
        if (await sha256((doc.salt || '') + oldPassword) !== doc.pass) return err('رمز فعلی اشتباه است');
        if (newPassword.length < 4) return err('رمز جدید حداقل ۴ کاراکتر باشد');
        const salt = Math.random().toString(16).slice(2, 10);
        publish(`${P()}/user/${self.id}`, { ...doc, salt, pass: await sha256(salt + newPassword) });
        return ok({ success: true, message: 'رمز عوض شد' });
    });

    /* ── پنل مدیر ── */
    const adminGuard = () => {
        const e = needAuth();
        if (e) return e;
        if (me().role !== 'admin') return err('فقط مدیر سیستم', 403);
        return null;
    };

    route('GET', '/api/admin/stats', async () => {
        const e = adminGuard(); if (e) return e;
        return ok({
            total_users: prefixDocs('user').length,
            total_groups: prefixDocs('group').length,
            total_messages: msgCache.length,
            total_posts: prefixDocs('post').length,
            total_likes: prefixDocs('like').length,
            total_comments: prefixDocs('cmt').length,
            total_follows: prefixDocs('follow').length,
            active_stories: prefixDocs('story').filter(d => d.value.expires_at > now()).length,
            online_now: allUsers().filter(u => isOnline(u.id)).length,
            generated_at: now()
        });
    });

    route('GET', '/api/admin/users', async () => {
        const e = adminGuard(); if (e) return e;
        return ok(allUsers().map(u => ({
            ...serializeUser(u),
            posts_count: prefixDocs('post').filter(d => d.value.user_id === u.id).length,
            messages_count: msgCache.filter(m => m.sender_id === u.id).length,
            last_seen_at: (getDoc(`presence/${u.id}`) || {}).at || null
        })));
    });

    route('POST', '/api/admin/promote_user/:id', async p => {
        const e = adminGuard(); if (e) return e;
        const doc = findUser(Number(p.id));
        if (!doc) return err('کاربر پیدا نشد', 404);
        publish(`${P()}/user/${doc.id}`, { ...doc, role: 'admin' });
        return ok({ success: true, user: serializeUser({ ...doc, role: 'admin' }) });
    });

    route('POST', '/api/admin/demote_user/:id', async p => {
        const e = adminGuard(); if (e) return e;
        const id = Number(p.id);
        if (id === me().id) return err('نمی‌توانی دسترسی خودت را بگیری');
        const doc = findUser(id);
        if (!doc) return err('کاربر پیدا نشد', 404);
        publish(`${P()}/user/${doc.id}`, { ...doc, role: 'user' });
        return ok({ success: true, user: serializeUser({ ...doc, role: 'user' }) });
    });

    route('DELETE', '/api/admin/delete_user/:id', async p => {
        const e = adminGuard(); if (e) return e;
        const id = Number(p.id);
        if (id === me().id) return err('نمی‌توانی حساب خودت را حذف کنی');
        const doc = findUser(id);
        if (!doc) return err('کاربر پیدا نشد', 404);
        publish(`${P()}/user/${id}`, null);
        publish(`${P()}/uname/${doc.username.toLowerCase()}`, null);
        publish(`${P()}/presence/${id}`, null);
        for (const d of prefixDocs('post')) if (d.value.user_id === id) publish(d.topic, null);
        for (const d of prefixDocs('story')) if (d.value.user_id === id) publish(d.topic, null);
        for (const d of prefixDocs('lan')) if (d.value.user_id === id) publish(d.topic, null);
        for (const d of prefixDocs('follow')) if (d.suffix.split('/').includes(String(id))) publish(d.topic, null);
        for (const d of prefixDocs('member')) if (d.suffix.split('/')[1] === String(id)) publish(d.topic, null);
        for (const d of prefixDocs('group')) if (d.value.creator_id === id) publish(d.topic, null);
        return ok({ success: true, message: 'کاربر حذف شد' });
    });

    route('DELETE', '/api/admin/delete_post/:id', async p => {
        const e = adminGuard(); if (e) return e;
        const id = String(p.id);
        if (!getDoc(`post/${id}`)) return err('پست پیدا نشد', 404);
        publish(`${P()}/post/${id}`, null);
        for (const d of prefixDocs('like')) if (d.suffix.split('/')[0] === id) publish(d.topic, null);
        for (const d of prefixDocs('cmt')) if (d.suffix.split('/')[0] === id) publish(d.topic, null);
        for (const d of prefixDocs('view')) if (d.suffix.split('/')[0] === id) publish(d.topic, null);
        broadcast('post_deleted', { post_id: Number(id) });
        return ok({ success: true, message: 'پست حذف شد' });
    });

    route('DELETE', '/api/admin/clear_all_messages', async () => {
        const e = adminGuard(); if (e) return e;
        const myId = me().id;
        const removed = msgCache.length;
        msgCache.length = 0;
        for (const scope of new Set(prefixDocs('pin').map(d => d.suffix))) publish(`${P()}/pin/${scope}`, null);
        broadcast('message_deleted', { all: true, by: myId });
        for (const u of allUsers()) publish(`${P()}/evt/dm/${u.id}`, { t: 'clear', by: myId }, { retain: false });
        socketEmit('message_deleted', { all: true, by: myId });
        return ok({ success: true, removed });
    });

    /* ───────── جایگزین window.fetch ───────── */

    const nativeFetch = root.fetch ? root.fetch.bind(root) : null;

    /**
     * صفحه روی Pages زیر یک زیردامنه است (https://user.github.io/JVL.PLATFORM/)
     * پس مسیرهای مطلقِ داخل index.html با آن پیشوند می‌آیند. این پیشوند را
     * از روی location پیدا و حذف می‌کنیم.
     */
    function basePath() {
        try {
            const p = root.location && root.location.pathname ? String(root.location.pathname) : '';
            const i = p.lastIndexOf('/');
            return i > 0 ? p.slice(0, i) : '';
        } catch { return ''; }
    }

    /** از هر URL (نسبی، مطلق یا با پیشوند Pages) فقط مسیر API را بیرون می‌کشد */
    function extractPath(url) {
        let s = String(url);
        s = s.replace(/^[a-z]+:\/\/[^/]+/i, '');
        if (!s.startsWith('/')) s = '/' + s;
        const q = s.indexOf('?');
        const query = new URLSearchParams(q >= 0 ? s.slice(q + 1) : '');
        let path = (q >= 0 ? s.slice(0, q) : s).replace(/\/+$/, '') || '/';
        const base = basePath();
        if (base && (path === base || path.startsWith(base + '/'))) path = path.slice(base.length) || '/';
        return { path, query };
    }

    /** اگر مسیر مستقیم مطابقت نکرد، پیشوندهای اضافی را یکی‌یکی کم می‌کند */
    function normalizePath(path) {
        if (routes.some(r => r.re.test(path))) return path;
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) {
            const candidate = '/' + parts.slice(i).join('/');
            if (routes.some(r => r.re.test(candidate))) return candidate;
        }
        return path;
    }

    async function jvlFetch(input, init = {}) {
        const rawUrl = typeof input === 'string' ? input : (input && input.url) || String(input);
        const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        const isOurs = /^\//.test(rawUrl) || /^(?!https?:)/.test(rawUrl);
        if (!isOurs) return nativeFetch ? nativeFetch(input, init) : Promise.reject(new Error('fetch unavailable'));

        /* سرور نود در دسترس است؟ همه‌چیز را به خودش بده */
        const active = mode || (mode = await modePromise);
        if (active === 'rest') return nativeFetch(input, init);

        const { path: rawPath, query } = extractPath(rawUrl);
        const path = normalizePath(rawPath);
        const matched = routes.find(r => r.method === method && r.re.test(path));
        if (!matched) {
            return jsonResponse({ status: 404, body: { success: false, message: 'مسیر پیدا نشد', path } });
        }
        const params = {};
        const m = matched.re.exec(path);
        matched.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        for (const [k, v] of query.entries()) params[k] = v;

        const meta = await parseBody(init && init.body);
        try {
            const result = await matched.handler(params, meta.body, meta);
            return jsonResponse(result);
        } catch (e) {
            console.error('[jvl-mqtt]', method, path, e);
            return jsonResponse({ status: 500, body: { success: false, message: 'خطای داخلی لایهٔ MQTT' } });
        }
    }

    async function parseBody(body) {
        if (!body) return { body: {}, file: null };
        if (typeof body === 'string') {
            try { return { body: JSON.parse(body), file: null }; } catch { return { body: {}, file: null }; }
        }
        /* FormData (مرورگر) یا polyfill نود */
        if (typeof FormData !== 'undefined' && body instanceof FormData) {
            const out = {};
            let file = null;
            for (const [k, v] of body.entries()) {
                if (v && typeof v === 'object' && typeof v.arrayBuffer === 'function') {
                    if (k === 'file') file = blobToFile(v);
                } else out[k] = v;
            }
            return { body: out, file };
        }
        return { body: {}, file: null };
    }

    /**
     * FileReader فقط Blob واقعی می‌خواند، پس آبجکت معمولی برنمی‌گردانیم.
     * در مرورگر مقدارِ FormData همیشه File است؛ در نود Blob بی‌نام است که
     * آن را در یک File می‌پیچیم تا name داشته باشد.
     */
    function blobToFile(blob) {
        try {
            if (typeof File !== 'undefined' && !(blob instanceof File)) {
                return new File([blob], blob.name || 'file', { type: blob.type || 'application/octet-stream' });
            }
        } catch { /* ignore */ }
        return blob;
    }

    function jsonResponse({ status, body }) {
        const text = JSON.stringify(body);
        return {
            ok: status >= 200 && status < 300,
            status,
            statusText: String(status),
            headers: { get: () => 'application/json' },
            json: async () => body,
            text: async () => text
        };
    }

    /* ───────── تشخیص حالت: REST (سرور نود) یا MQTT (استاتیک/Pages) ───────── */

    /**
     * اگر یک سرور نود پشت همین آدرس باشد، `/api/app_info` را با پاسخ
     * {name, version, node, …} می‌دهد (بدون فیلد transport). در آن حالت همهٔ
     * درخواست‌ها را به سرور واقعی واگذار می‌کنیم و socket.io را بارگذاری
     * می‌کنیم. در غیر این صورت (مثلاً روی GitHub Pages) حالت MQTT فعال است.
     */
    let mode = null;
    const modePromise = (async () => {
        try {
            if (nativeFetch) {
                const r = await nativeFetch(`${basePath()}/api/app_info`, { cache: 'no-store' });
                if (r && r.ok) {
                    const info = await r.json();
                    if (info && info.version && !info.transport) {
                        loadScript(`${basePath()}/static/js/socket.io.min.js`).catch(() => {});
                        return 'rest';
                    }
                }
            }
        } catch { /* سروری در کار نیست */ }
        return 'mqtt';
    })();
    modePromise.then(m => { mode = m; });

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            if (typeof document === 'undefined') { resolve(); return; }
            const el = document.createElement('script');
            el.src = src;
            el.onload = () => resolve();
            el.onerror = () => reject(new Error('بارگذاری ' + src + ' ناموفق بود'));
            document.head.appendChild(el);
        });
    }

    /* ───────── نصب روی window ───────── */

    /* تغییرات state که باید UI را خبر کنند */
    onStateChange((kind, info) => {
        if (!info || !info.topic) return;
        const t = info.topic;
        /*
         * حضور: «user_status» را فقط وقتی بده که فهرست آنلاین‌ها واقعاً عوض شده
         * باشد، وگرنه هر بار که حضور خودمان را دوباره منتشر می‌کنیم صفحه
         * loadUsers() می‌زند و حلقهٔ بازخورد درست می‌شود.
         */
        if (t.startsWith(`${P()}/presence/`)) {
            const online = allUsers().filter(u => isOnline(u.id)).map(u => u.id).sort((a, b) => a - b);
            const key = online.join(',');
            if (key !== lastOnlineKey) { lastOnlineKey = key; socketEmit('user_status', { online }); }
        }
        else if (t.startsWith(`${P()}/group/`) || t.startsWith(`${P()}/member/`)) socketEmit('groups_changed', {});
    });

    root.JVL = {
        version: Config.appVersion,
        config: Config,
        brokers: BROKERS,
        setBroker(url) { store.setItem(LS.broker, url); Config.broker = url; return reconnect(); },
        setNetworkKey(key) { store.setItem(LS.key, key); Config.networkKey = key; cache.clear(); return reconnect(); },
        connect,
        /** بستن کامل اتصال (برای تست و خاموش‌کردن صفحه) */
        shutdown() {
            ready = false; willUserId = null; connecting = null;
            if (client) { try { client.end(true); } catch { /* ignore */ } client = null; }
        },
        reconnect() {
            ready = false;
            if (client) { try { client.end(true); } catch { /* ignore */ } client = null; }
            connecting = null;
            return connect();
        },
        state: { cache, msgCache, isOnline, allUsers, allPosts, ready: () => ready, topics: () => [...cache.keys()] },
        mediaURL,
        mode: () => mode
    };

    /* اگر حالت REST تشخیص داده شود، socket.io.min.js این تابع را بازنویسی می‌کند */
    root.io = function io() { return makeSocket(); };

    /*
     * اتصال را از همان لحظهٔ باز شدن صفحه شروع می‌کنیم (بدون هویت، پس بدون
     * Last Will). وگرنه اولین «ورود» باید کل handshake را منتظر بماند و کاربر
     * چند ثانیه دکمهٔ قفل‌شده می‌بیند.
     */
    modePromise.then(m => { if (m === 'mqtt') { try { connect().catch(() => {}); } catch { /* ignore */ } } });
    root.fetch = jvlFetch;

    /**
     * رسانه: در حالت MQTT مقدار یک data URL است و در حالت REST نام فایل.
     * index.html همهٔ تصویرها را از اینجا می‌گیرد تا هر دو حالت کار کنند.
     */
    function mediaURL(kind, value) {
        if (value == null || value === '') return '';
        const v = String(value);
        if (v.startsWith('data:') || v.startsWith('blob:')) return v;
        /* ارجاع به رسانهٔ تکه‌تکه: تا کامل نرسیده، خالی برمی‌گردد */
        if (v.startsWith('media:')) return mediaCache.get(v.slice(6)) || '';
        return `${basePath()}/files/${kind}/${encodeURIComponent(v)}`;
    }
    root.mediaURL = mediaURL;

    /* وقتی مرورگر بسته/مخفی می‌شود، حضور را آفلاین کن */
    if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', () => { try { publishPresence(false); } catch { /* ignore */ } });
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = root.JVL;
        /* دسترسی تست‌ها به درونیات */
        module.exports.__test = {
            cache, msgCache, routes, publish, connect, jvlFetch, makeSocket, socketEmit,
            Config, P, prefixDocs, getDoc, isOnline, allUsers, serializeUser, newId, now, sha256
        };
    }
})(typeof window !== 'undefined' ? window : globalThis);
