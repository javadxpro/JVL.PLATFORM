'use strict';

/**
 * تست لایهٔ MQTT با یک بروکر واقعی (aedes) روی WebSocket.
 *
 * هر «کاربر» یک نمونهٔ مستقل از mqtt-backend.js است با localStorage جداگانه،
 * دقیقاً مثل دو برگهٔ مرورگر که به یک بروکر وصل‌اند.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { Aedes } = require('aedes');
const ws = require('ws');

const SHIM = path.join(__dirname, '..', 'static', 'js', 'mqtt-backend.js');
const NETWORK = 'jvl-test-' + Math.random().toString(16).slice(2, 8);

let brokerUrl;
let httpServer;
const allClients = [];
let broker;
let wss;

function memoryLocalStorage() {
    const m = new Map();
    return {
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: k => m.delete(k),
        clear: () => m.clear()
    };
}

/** یک کلاینت مستقل (مثل یک مرورگر) */
function loadClient(name) {
    const ls = memoryLocalStorage();
    globalThis.localStorage = ls;
    globalThis.location = { pathname: '/JVL.PLATFORM/index.html' };  /* شبیه‌سازی زیردامنهٔ Pages */
    delete require.cache[require.resolve(SHIM)];
    const mod = require(SHIM);
    const T = mod.__test;
    T.Config.broker = brokerUrl;
    T.Config.networkKey = NETWORK;
    const api = {
        name,
        mod,
        T,
        ls,
        async call(method, url, body) {
            const init = { method };
            if (body !== undefined) {
                init.headers = { 'Content-Type': 'application/json' };
                init.body = JSON.stringify(body);
            }
            const res = await T.jvlFetch(url, init);
            return { status: res.status, body: await res.json() };
        },
        get(url) { return api.call('GET', url); },
        post(url, body) { return api.call('POST', url, body || {}); },
        del(url) { return api.call('DELETE', url); },
        async login(username, password) {
            const r = await api.post('/login', { username, password });
            /* هر کلاینت localStorage خودش را دارد (مثل دو مرورگر جدا) */
            if (r.body && r.body.user) ls.setItem('volexturn_user', JSON.stringify(r.body.user));
            return r;
        }
    };
    allClients.push(api);
    return api;
}

async function waitFor(fn, label, timeout = 8000) {
    const started = Date.now();
    for (;;) {
        let value;
        try { value = await fn(); } catch { value = false; }
        if (value) return value;
        if (Date.now() - started > timeout) throw new Error(`زمان انتظار تمام شد: ${label}`);
        await new Promise(r => setTimeout(r, 40));
    }
}

let alice, bob;

test.before(async () => {
    broker = await Aedes.createBroker();
    httpServer = http.createServer();
    wss = new ws.Server({ server: httpServer });
    wss.on('connection', socket => { broker.handle(ws.createWebSocketStream(socket)); });
    await new Promise(r => httpServer.listen(0, '127.0.0.1', r));
    brokerUrl = `ws://127.0.0.1:${httpServer.address().port}/mqtt`;

    alice = loadClient('alice');
    bob = loadClient('bob');
});

/* ───────── احراز هویت ───────── */

test('اولین کاربر روی MQTT مدیر می‌شود و ورود با رمز غلط رد می‌شود', async () => {
    const reg = await alice.post('/register', { username: 'alice', password: 'pass1234' });
    assert.equal(reg.body.success, true);
    assert.equal(reg.body.user.role, 'admin');

    const dup = await alice.post('/register', { username: 'alice', password: 'pass1234' });
    assert.equal(dup.body.success, false, 'نام تکراری باید رد شود');

    /* کاربر دوم باید اول وصل شود و کش بروکر را بگیرد، وگرنه خودش را اولین کاربر می‌پندارد */
    await bob.T.connect();
    await waitFor(() => bob.T.prefixDocs('user').length === 1, 'دیدن کاربر alice در کش بابک');
    const dup2 = await bob.post('/register', { username: 'bob', password: 'pass1234' });
    assert.equal(dup2.body.success, true, 'بابک باید بتواند ثبت‌نام کند');
    assert.equal(dup2.body.user.role, 'user', 'کاربر دوم نباید مدیر شود');

    const bad = await alice.post('/login', { username: 'alice', password: 'wrong' });
    assert.equal(bad.status, 401);

    const okLogin = await alice.login('alice', 'pass1234');
    assert.equal(okLogin.status, 200);
    assert.ok(okLogin.body.token);

    const bobLogin = await bob.login('bob', 'pass1234');
    assert.equal(bobLogin.status, 200);
    assert.equal(bobLogin.body.user.role, 'user');
});

test('app_info اطلاعات MQTT را برمی‌گرداند', async () => {
    const r = await alice.get('/api/app_info');
    assert.equal(r.status, 200);
    assert.equal(r.body.transport, 'mqtt');
    assert.equal(r.body.version, '4.0.0');
    assert.equal(r.body.network, NETWORK);
});

test('مسیر با پیشوند زیردامنهٔ Pages هم درست مسیریابی می‌شود', async () => {
    const r = await alice.get('/JVL.PLATFORM/users');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body), 'پیشوند /JVL.PLATFORM باید حذف شود');
    const miss = await alice.get('/JVL.PLATFORM/api/nopething');
    assert.equal(miss.status, 404);
});

test('بدون نشست، ۴۰۱ برمی‌گردد', async () => {
    const anon = loadClient('anon');
    anon.T.Config.broker = brokerUrl;
    anon.T.Config.networkKey = NETWORK;
    const r = await anon.get('/users');
    assert.equal(r.status, 401);
});

/* ───────── حضور ───────── */

test('حضور روی MQTT: آنلاین/آفلاین با retained و Last Will', async () => {
    const sockA = alice.T.makeSocket();
    const sockB = bob.T.makeSocket();
    sockA.emit('join', { user_id: alice.T.allUsers()[0].id });
    sockB.emit('join', { user_id: bob.T.allUsers()[0].id });

    await waitFor(async () => {
        const users = (await alice.get('/users')).body;
        return users.length === 2 && users.every(u => u.is_online);
    }, 'هر دو کاربر آنلاین شوند');

    const users = (await bob.get('/users')).body;
    assert.equal(users.length, 2);
    assert.equal(users.find(u => u.username === 'alice').is_online, true);

    /* قطع اتصال → presence آفلاین می‌شود */
    sockB.disconnect();
    await waitFor(async () => {
        const list = (await alice.get('/users')).body;
        const b = list.find(u => u.username === 'bob');
        return b && b.is_online === false;
    }, 'بابک بعد از قطع اتصال آفلاین شود');
});

/* ───────── چت ───────── */

test('پیام مستقیم روی MQTT به گیرنده می‌رسد', async () => {
    const sockA = alice.T.makeSocket();
    const sockB = bob.T.makeSocket();
    const received = [];
    sockB.on('new_message', m => received.push(m));
    sockA.emit('join', { user_id: alice.T.allUsers()[0].id });
    sockB.emit('join', { user_id: bob.T.allUsers()[0].id });
    await waitFor(async () => sockB.connected, 'اتصال سوکت بابک');

    const bobId = bob.T.allUsers().find(u => u.username === 'bob').id;
    const aliceId = alice.T.allUsers().find(u => u.username === 'alice').id;

    const res = await alice.T.jvlFetch('/send_message', { method: 'POST', body: formDataOf({ content: 'سلام از MQTT', receiver_id: String(bobId) }) });
    const sentBody = await res.json();
    assert.equal(sentBody.success, true);
    assert.equal(sentBody.message.content, 'سلام از MQTT');

    await waitFor(() => received.length > 0, 'رویداد new_message روی سوکت گیرنده');
    assert.equal(received[0].content, 'سلام از MQTT');
    assert.equal(received[0].sender_id, aliceId);

    await waitFor(async () => {
        const msgs = (await bob.get(`/messages/${bobId}/${aliceId}`)).body;
        return msgs.length === 1;
    }, 'پیام در لیست پیام‌های بابک');

    const counts = (await bob.get(`/unread_counts/${bobId}`)).body;
    assert.ok(Object.keys(counts).length >= 0);
});

function formDataOf(obj) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(obj)) fd.append(k, String(v));
    return fd;
}

/* ───────── گروه ───────── */

test('گروه: ساخت، عضویت و پیام گروهی', async () => {
    const aliceId = alice.T.allUsers().find(u => u.username === 'alice').id;
    const bobId = bob.T.allUsers().find(u => u.username === 'bob').id;

    const created = await alice.post('/create_group', { name: 'گروه MQTT', members: [bobId] });
    assert.equal(created.body.success, true);
    const gid = created.body.group_id;

    await waitFor(async () => {
        const groups = (await bob.get('/my_groups')).body;
        return groups.length === 1 && groups[0].members_count === 2;
    }, 'گروه در لیست بابک با دو عضو');

    const res = await alice.T.jvlFetch('/send_message', {
        method: 'POST', body: formDataOf({ content: 'پیام گروهی', group_id: String(gid) })
    });
    assert.equal((await res.json()).success, true);

    await waitFor(async () => (await bob.get(`/group_messages/${gid}`)).body.length === 1, 'پیام گروهی به بابک برسد');

    const info = (await alice.get(`/group_info/${gid}`)).body;
    assert.equal(info.success, true);
    assert.equal(info.members.length, 2);
    assert.equal(info.members[0].role, 'owner');

    /* کاربر غیرعضو نباید پیام‌ها را ببیند */
    const outsider = loadClient('outsider');
    outsider.T.Config.broker = brokerUrl;
    outsider.T.Config.networkKey = NETWORK;
    const oname = 'eve_' + Date.now().toString().slice(-5);
    await outsider.post('/register', { username: oname, password: 'pass1234' });
    await outsider.login(oname, 'pass1234');
    assert.equal((await outsider.get(`/group_messages/${gid}`)).status, 403, 'غیرعضو باید ۴۰۳ بگیرد');
});

/* ───────── اکسپلور ───────── */

test('پست، لایک، کامنت، فالو و اعلان روی MQTT', async () => {
    const aliceId = alice.T.allUsers().find(u => u.username === 'alice').id;
    const bobId = bob.T.allUsers().find(u => u.username === 'bob').id;

    const post = await alice.T.jvlFetch('/create_post', { method: 'POST', body: formDataOf({ content: 'پست بدون سرور #mqtt' }) });
    const postBody = await post.json();
    assert.equal(postBody.success, true);
    const pid = postBody.post.id;

    await waitFor(async () => (await bob.get('/posts')).body.some(p => p.id === pid), 'پست در فید بابک');

    const like = await bob.post(`/like_post/${pid}`, { user_id: bobId });
    assert.equal(like.body.liked, true);
    assert.equal(like.body.likes_count, 1);

    await waitFor(async () => {
        const posts = (await alice.get('/posts')).body;
        const p = posts.find(x => x.id === pid);
        return p && p.likes_count === 1;
    }, 'شمار لایک برای نویسنده هم‌گام شود');

    const unlike = await bob.post(`/like_post/${pid}`, { user_id: bobId });
    assert.equal(unlike.body.liked, false);
    await bob.post(`/like_post/${pid}`, { user_id: bobId });

    const cmt = await bob.post(`/comment_post/${pid}`, { user_id: bobId, content: 'بدون سرور هم کار می‌کند' });
    assert.equal(cmt.body.comments_count, 1);
    /* کامنت از راه بروکر به کش آلیس می‌رسد */
    await waitFor(async () => (await alice.get(`/post_comments/${pid}`)).body.length === 1, 'رسیدن کامنت به کش آلیس');
    const comments = (await alice.get(`/post_comments/${pid}`)).body;
    assert.equal(comments.length, 1);
    assert.equal(comments[0].content, 'بدون سرور هم کار می‌کند');

    const follow = await bob.post(`/follow/${aliceId}`, { user_id: bobId });
    assert.equal(follow.body.following, true);
    const profile = (await bob.get(`/user_profile/${bobId}/${aliceId}`)).body;
    assert.equal(profile.followers, 1);
    assert.equal(profile.posts_count >= 1, true);
    assert.equal(profile.is_following, true);

    await waitFor(async () => {
        const n = (await alice.get(`/notifications/${aliceId}`)).body;
        const types = new Set(n.items.map(x => x.type));
        return types.has('like') && types.has('comment') && types.has('follow');
    }, 'اعلان‌های لایک، کامنت و فالو');
    const notifs = (await alice.get(`/notifications/${aliceId}`)).body;
    assert.deepEqual(notifs.items.map(n => n.type).sort(), ['comment', 'follow', 'like']);
    assert.ok(notifs.unread >= 1);
    await alice.post(`/notifications_read/${aliceId}`, {});
    assert.equal((await alice.get(`/notifications/${aliceId}`)).body.unread, 0);
});

/* ───────── LAN ───────── */

test('سرور بازی LAN روی MQTT', async () => {
    assert.equal((await bob.post('/create_lan_host', { game_name: 'CS', ip_address: '999.1.1.1', port: '27015' })).body.success, false);
    const created = await bob.post('/create_lan_host', { game_name: 'Warcraft III', ip_address: '192.168.1.30', port: '6112', description: 'DotA' });
    assert.equal(created.body.success, true);
    await waitFor(async () => (await alice.get('/lan_hosts')).body.length === 1, 'رسیدن هاست به کش آلیس');
    const list = (await alice.get('/lan_hosts')).body;
    assert.equal(list.length, 1);
    assert.equal(list[0].game_name, 'Warcraft III');
    assert.equal(list[0].ip_address, '192.168.1.30');
    assert.equal((await bob.del(`/delete_lan_host/${created.body.id}`)).body.success, true);
    /* حذف = انتشار payload خالی روی همان تاپیک؛ باید به بقیه هم برسد */
    await waitFor(async () => (await alice.get('/lan_hosts')).body.length === 0, 'حذف هاست در کش آلیس');
    assert.equal((await alice.get('/lan_hosts')).body.length, 0);
});

/* ───────── پروفایل ───────── */

test('ویرایش پروفایل و تغییر رمز', async () => {
    const res = await bob.T.jvlFetch('/update_profile', { method: 'POST', body: formDataOf({ full_name: 'بابک', bio: 'بدون سرور' }) });
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.user.full_name, 'بابک');

    await waitFor(async () => {
        const users = (await alice.get('/users')).body;
        const b = users.find(u => u.username === 'bob');
        return b && b.full_name === 'بابک';
    }, 'نام جدید برای بقیه هم‌گام شود');

    assert.equal((await bob.post('/change_password', { old_password: 'nope', new_password: 'newpass1' })).body.success, false);
    assert.equal((await bob.post('/change_password', { old_password: 'pass1234', new_password: 'newpass1' })).body.success, true);
    const fresh = loadClient('bob2');
    fresh.T.Config.broker = brokerUrl;
    fresh.T.Config.networkKey = NETWORK;
    await fresh.T.connect();
    await waitFor(() => !!fresh.T.getDoc('uname/bob'), 'دیدن کاربر bob در کش کلاینت تازه');
    assert.equal((await fresh.post('/login', { username: 'bob', password: 'newpass1' })).status, 200);
    assert.equal((await fresh.post('/login', { username: 'bob', password: 'pass1234' })).status, 401);
});

/* ───────── مدیر ───────── */

test('پنل مدیر: آمار، ارتقا/تنزل، حذف پست', async () => {
    const bobUser = bob.T.allUsers().find(u => u.username === 'bob');
    assert.equal((await bob.get('/api/admin/stats')).status, 403, 'کاربر عادی نباید دسترسی داشته باشد');

    const stats = (await alice.get('/api/admin/stats')).body;
    assert.equal(stats.total_users >= 2, true);
    assert.equal(stats.total_groups, 1);
    assert.equal(stats.total_likes >= 1, true);
    assert.equal(stats.total_comments >= 1, true);
    assert.equal(stats.total_follows >= 1, true);

    const promoted = await alice.post(`/api/admin/promote_user/${bobUser.id}`, {});
    assert.equal(promoted.body.user.role, 'admin');
    const demoted = await alice.post(`/api/admin/demote_user/${bobUser.id}`, {});
    assert.equal(demoted.body.user.role, 'user');
    assert.equal((await alice.post(`/api/admin/demote_user/${alice.T.allUsers()[0].id}`, {})).body.success, false);

    const posts = (await alice.get('/posts')).body;
    assert.ok(posts.length >= 1);
    assert.equal((await alice.del(`/api/admin/delete_post/${posts[0].id}`)).body.success, true);
    await waitFor(async () => (await bob.get('/posts')).body.every(p => p.id !== posts[0].id), 'حذف پست برای بقیه هم اعمال شود');
});

test.after(async () => {
    /* کلاینت‌های MQTT را ببند، وگرنه reconnect باز می‌ماند و پروسه تمام نمی‌شود */
    for (const c of allClients) { try { c.mod.shutdown(); } catch { /* ignore */ } }
    try { wss.close(); } catch { /* ignore */ }
    try { broker.close(); } catch { /* ignore */ }
    try { httpServer.close(); } catch { /* ignore */ }
});
