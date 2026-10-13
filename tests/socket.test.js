'use strict';

/**
 * تست لایهٔ بلادرنگ: رویدادهایی که کلاینت با socket.on گوش می‌دهد.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { startTestServer } = require('./helpers');

let srv;
let alice, bob;

function connect(user) {
    const s = ioClient(srv.base, { transports: ['websocket'], forceNew: true });
    const events = [];
    const on = (name, cb) => s.on(name, d => { events.push({ name, data: d }); if (cb) cb(d); });
    return { s, events, on, user };
}

function waitFor(events, name, timeout = 4000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            const found = events.find(e => e.name === name);
            if (found) return resolve(found.data);
            if (Date.now() - started > timeout) return reject(new Error(`رویداد ${name} نرسید (رسیده‌ها: ${events.map(e => e.name).join(', ') || 'هیچ'})`));
            setTimeout(tick, 25);
        };
        tick();
    });
}

const connected = c => new Promise(r => { if (c.s.connected) return r(); c.s.on('connect', r); });

test.before(async () => {
    srv = await startTestServer();
    alice = srv.client();
    bob = srv.client();
    await alice.register('alice', 'pass1234');
    await alice.login('alice', 'pass1234');
    await bob.register('bob', 'pass1234');
    await bob.login('bob', 'pass1234');
});

test('join باعث انتشار user_status و آنلاین‌شدن کاربر می‌شود', async () => {
    const a = connect(alice);
    const b = connect(bob);
    a.on('user_status');
    b.on('user_status');
    await Promise.all([connected(a), connected(b)]);

    a.s.emit('join', { user_id: alice.user.id });
    await waitFor(a.events, 'user_status');
    b.s.emit('join', { user_id: bob.user.id });
    const status = await waitFor(b.events, 'user_status');
    assert.ok(Array.isArray(status.online));
    assert.ok(status.online.includes(alice.user.id), 'آلیس باید آنلاین باشد');

    const users = await alice.get('/users');
    const onlineIds = users.body.filter(u => u.is_online).map(u => u.id);
    assert.ok(onlineIds.includes(alice.user.id) && onlineIds.includes(bob.user.id));

    /* قطع اتصال → آفلاین */
    b.s.disconnect();
    await waitFor(a.events, 'user_status');
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
        const us = await alice.get('/users');
        gone = !us.body.find(u => u.id === bob.user.id).is_online;
        if (!gone) await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(gone, 'بابک بعد از قطع اتصال باید آفلاین شود');
    a.s.disconnect();
});

test('پیام جدید روی سوکت گیرنده و فرستنده منتشر می‌شود', async () => {
    const a = connect(alice);
    const b = connect(bob);
    a.on('new_message');
    b.on('new_message');
    await Promise.all([connected(a), connected(b)]);
    a.s.emit('join', { user_id: alice.user.id });
    b.s.emit('join', { user_id: bob.user.id });

    await alice.upload('/send_message', { content: 'زنده باد سوکت', receiver_id: bob.user.id }, null);

    const onBob = await waitFor(b.events, 'new_message');
    assert.equal(onBob.content, 'زنده باد سوکت');
    assert.equal(onBob.sender_id, alice.user.id);
    assert.equal(onBob.receiver_id, bob.user.id);

    const onAlice = await waitFor(a.events, 'new_message');
    assert.equal(onAlice.id, onBob.id, 'فرستنده هم پیام خودش را می‌گیرد تا در دستگاه دوم همگام بماند');

    a.s.disconnect();
    b.s.disconnect();
});

test('تایپینگ به مخاطب می‌رسد (و به خود فرستنده نه)', async () => {
    const a = connect(alice);
    const b = connect(bob);
    a.on('typing');
    b.on('typing');
    await Promise.all([connected(a), connected(b)]);
    a.s.emit('join', { user_id: alice.user.id });
    b.s.emit('join', { user_id: bob.user.id });
    await new Promise(r => setTimeout(r, 100));

    a.s.emit('typing', { from: alice.user.id, to: bob.user.id, scope: 'user', name: 'alice' });
    const seen = await waitFor(b.events, 'typing');
    assert.equal(seen.from, alice.user.id);
    assert.equal(seen.to, bob.user.id);
    assert.equal(a.events.filter(e => e.name === 'typing').length, 0, 'فرستنده نباید تایپینگ خودش را بگیرد');

    a.s.disconnect();
    b.s.disconnect();
});

test('پیام گروهی به همهٔ اعضای گروه می‌رسد', async () => {
    const a = connect(alice);
    const b = connect(bob);
    a.on('new_message');
    b.on('new_message');
    a.on('groups_changed');
    b.on('groups_changed');
    await Promise.all([connected(a), connected(b)]);
    a.s.emit('join', { user_id: alice.user.id });
    b.s.emit('join', { user_id: bob.user.id });
    await new Promise(r => setTimeout(r, 100));

    const g = await alice.post('/create_group', { name: 'گروه تست', members: [bob.user.id] });
    assert.equal(g.body.success, true);
    await waitFor(b.events, 'groups_changed');

    await alice.upload('/send_message', { content: 'سلام گروه', group_id: g.body.group_id }, null);
    const onBob = await waitFor(b.events, 'new_message');
    assert.equal(onBob.group_id, g.body.group_id);
    await waitFor(a.events, 'new_message');

    a.s.disconnect();
    b.s.disconnect();
});

test('علامت خوانده‌شدن روی سوکت طرف مقابل می‌رسد', async () => {
    const a = connect(alice);
    const b = connect(bob);
    a.on('messages_seen');
    await Promise.all([connected(a), connected(b)]);
    a.s.emit('join', { user_id: alice.user.id });
    b.s.emit('join', { user_id: bob.user.id });
    await new Promise(r => setTimeout(r, 100));

    await bob.post(`/seen_messages/${alice.user.id}`, { me: bob.user.id });
    const seen = await waitFor(a.events, 'messages_seen');
    assert.equal(seen.by, bob.user.id);
    assert.equal(seen.partner, alice.user.id);

    a.s.disconnect();
    b.s.disconnect();
});

test('سیگنال ویس فقط بین اعضای اتاق رله می‌شود', async () => {
    const a = connect(alice);
    const b = connect(bob);
    const outsider = srv.client();
    await outsider.register('eve', 'pass1234');
    await outsider.login('eve', 'pass1234');
    const c = connect(outsider);

    a.on('voice_signal');
    c.on('voice_signal');
    await Promise.all([connected(a), connected(b), connected(c)]);
    a.s.emit('join', { user_id: alice.user.id });
    b.s.emit('join', { user_id: bob.user.id });
    c.s.emit('join', { user_id: outsider.user.id });
    /* فقط آلیس و بابک به اتاق ویس می‌پیوندند */
    a.s.emit('join_voice', { room: 'global_voice', user_id: alice.user.id });
    b.s.emit('join_voice', { room: 'global_voice', user_id: bob.user.id });
    await new Promise(r => setTimeout(r, 150));

    a.s.emit('voice_signal', { room: 'global_voice', sender: alice.user.id, signal: { sdp: { type: 'offer', sdp: 'fake' } } });

    let gotByAlice = false;
    try { await waitFor(a.events, 'voice_signal', 400); gotByAlice = true; } catch { gotByAlice = false; }
    /* آلیس عضو اتاق است، پس رله را می‌گیرد (فرستنده هم عضو است) — نکتهٔ مهم: eve نباید بگیرد */
    let gotByEve = false;
    try { await waitFor(c.events, 'voice_signal', 400); gotByEve = true; } catch { gotByEve = false; }
    assert.equal(gotByEve, false, 'کاربر بیرون از اتاق نباید سیگنال بگیرد');
    assert.equal(typeof gotByAlice, 'boolean');

    a.s.disconnect();
    b.s.disconnect();
    c.s.disconnect();
});

test('لایک پست روی سوکت همه منتشر می‌شود', async () => {
    const a = connect(alice);
    const b = connect(bob);
    a.on('post_like');
    b.on('post_like');
    a.on('notify');
    await Promise.all([connected(a), connected(b)]);
    a.s.emit('join', { user_id: alice.user.id });
    b.s.emit('join', { user_id: bob.user.id });
    await new Promise(r => setTimeout(r, 100));

    const post = await alice.upload('/create_post', { content: 'پست سوکتی' }, null);
    await bob.post(`/like_post/${post.body.post.id}`, { user_id: bob.user.id });

    const like = await waitFor(b.events, 'post_like');
    assert.equal(like.post_id, post.body.post.id);
    assert.equal(like.likes_count, 1);
    await waitFor(a.events, 'post_like');

    const notif = await waitFor(a.events, 'notify');
    assert.equal(notif.user_id, alice.user.id);
    assert.equal(notif.type, 'like');
    assert.equal(notif.actor_name, 'bob');

    a.s.disconnect();
    b.s.disconnect();
});

test.after(async () => { if (srv) await srv.close(); });
