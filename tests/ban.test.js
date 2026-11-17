'use strict';

/**
 * تست بن‌کردن کاربر و نشانی IP.
 *
 * چرا فایل جدا؟ چون همهٔ کلاینت‌های تست از 127.0.0.1 وصل می‌شوند و اگر
 * اعتماد به پروکسی را سراسری روشن کنیم، بقیهٔ مجموعه تست به هم می‌ریزد.
 * اینجا JVL_TRUST_PROXY=1 است و هر کلاینت با X-Forwarded-For خودش یک IP
 * متمایز دارد — دقیقاً همان شکلِ پشت ریورس‌پروکسی در دنیای واقعی.
 */

process.env.JVL_TRUST_PROXY = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let srv;
let admin;   /* اولین کاربر → مدیر */
let bob;     /* قرار است بن شود */
let carol;   /* کاربر سالم با IP دیگر */

const IP_BOB = '91.98.7.211';
const IP_CAROL = '2.178.45.9';

/** درخواست با یک IP مشخص (انگار از همان نشانی آمده) */
const from = (client, ip) => ({
    get: (u) => client.get(u, { headers: { 'X-Forwarded-For': ip } }),
    post: (u, b) => client.post(u, b, { headers: { 'X-Forwarded-For': ip } }),
    del: (u) => client.del(u, { headers: { 'X-Forwarded-For': ip } })
});

/** ورود با IP مشخص تا last_ip همان ثبت شود */
async function loginFrom(client, username, password, ip) {
    const r = await client.post('/login', { username, password }, { headers: { 'X-Forwarded-For': ip } });
    if (r.body && r.body.token) { client.token = r.body.token; client.user = r.body.user; }
    return r;
}

test.before(async () => {
    srv = await startTestServer();
    admin = srv.client();
    bob = srv.client();
    carol = srv.client();

    await admin.register('root', 'rootpass1');
    await bob.register('bob', 'bobpass1');
    await carol.register('carol', 'carolpass1');

    await loginFrom(admin, 'root', 'rootpass1', '5.100.1.1');
    await loginFrom(bob, 'bob', 'bobpass1', IP_BOB);
    await loginFrom(carol, 'carol', 'carolpass1', IP_CAROL);
});

test('ورود، آخرین IP کاربر را ثبت می‌کند', async () => {
    const users = await from(admin, '5.100.1.1').get('/api/admin/users');
    const b = users.body.find(u => u.username === 'bob');
    assert.equal(b.last_ip, IP_BOB, 'IP آخرین نشست باید ثبت شود');
    assert.equal(b.banned, false);
});

test('بدون نقش مدیر نمی‌شود کسی را بن کرد', async () => {
    const r = await from(bob, IP_BOB).post(`/api/admin/ban_user/${carol.user.id}`, { reason: 'من ادمینم' });
    assert.equal(r.status, 403);
});

test('نمی‌شود خود را بن کرد و نمی‌شود لوکال‌هاست را بست', async () => {
    const self = await from(admin, '5.100.1.1').post(`/api/admin/ban_user/${admin.user.id}`, {});
    assert.equal(self.body.success, false, 'بنِ خود باید رد شود');

    const local = await from(admin, '5.100.1.1').post('/api/admin/ban_ip', { ip: '127.0.0.1' });
    assert.equal(local.body.success, false, 'بستن لوکال‌هاست یعنی قفل‌کردن در به روی خودت');
    assert.match(local.body.message, /لوکال‌هاست/);

    const bad = await from(admin, '5.100.1.1').post('/api/admin/ban_ip', { ip: 'not-an-ip' });
    assert.equal(bad.body.success, false);
});

test('بنِ کاربر: حساب و نشانی‌اش هر دو بسته می‌شوند', async () => {
    const r = await from(admin, '5.100.1.1').post(`/api/admin/ban_user/${bob.user.id}`, { reason: 'اسپم' });
    assert.equal(r.body.success, true, JSON.stringify(r.body));
    assert.equal(r.body.banned_ip, IP_BOB, 'IP آخرین نشست باید بسته شود');
    assert.equal(r.body.user.banned, true);

    /* فهرست نشانی‌های مسدود */
    const list = await from(admin, '5.100.1.1').get('/api/admin/banned_ips');
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].ip, IP_BOB);
    assert.equal(list.body[0].reason, 'اسپم');
    assert.equal(list.body[0].banned_by_name, 'root', 'نام مدیر بن‌کننده باید بیاید');
});

test('بن همان لحظه اثر می‌کند، نه فقط در ورود بعدی', async () => {
    /* توکنِ bob هنوز از نظر امضا معتبر است؛ باید با ۴۰۳ رد شود */
    const r = await from(bob, IP_BOB).get('/users');
    assert.equal(r.status, 403);
    assert.equal(r.body.banned, true);
    assert.match(r.body.message, /اسپم/, 'دلیل بن باید به کاربر نشان داده شود');
});

test('نشانیِ بن‌شده حتی به مسیرهای عمومی نمی‌رسد', async () => {
    /* مهم‌ترین بخش: اگر بن بعد از احراز هویت بود، با حساب تازه برمی‌گشت */
    const anon = srv.client();
    const login = await anon.post('/login', { username: 'bob', password: 'bobpass1' },
        { headers: { 'X-Forwarded-For': IP_BOB } });
    assert.equal(login.status, 403);
    assert.equal(login.body.banned, true);

    const reg = await anon.post('/register', { username: 'bob2', password: 'pass1234' },
        { headers: { 'X-Forwarded-For': IP_BOB } });
    assert.equal(reg.status, 403, 'ثبت‌نام از نشانی بن‌شده باید بسته باشد');

    const meta = await anon.get('/api/app_info', { headers: { 'X-Forwarded-For': IP_BOB } });
    assert.equal(meta.status, 403, 'حتی مسیرهای متا باید بسته باشند');
});

test('کاربر سالم با نشانی دیگر unaffected می‌ماند', async () => {
    /* اگر بن سراسری بود، این تست می‌ترکید */
    const me = await from(carol, IP_CAROL).get('/users');
    assert.equal(me.status, 200);
    assert.ok(Array.isArray(me.body));

    const msg = await from(carol, IP_CAROL).post('/send_message', { receiver_id: admin.user.id, content: 'سلام' });
    assert.equal(msg.body.success, true, 'کاربر سالم باید بتواند پیام بدهد');
});

test('باز کردن نشانی، دسترسی را برمی‌گرداند ولی حساب همچنان بن است', async () => {
    const off = await from(admin, '5.100.1.1').del(`/api/admin/unban_ip/${encodeURIComponent(IP_BOB)}`);
    assert.equal(off.body.success, true);

    /* نشانی باز است، پس به مسیر می‌رسد — ولی رمز درست هم ۴۰۳ می‌گیرد */
    const anon = srv.client();
    const login = await anon.post('/login', { username: 'bob', password: 'bobpass1' },
        { headers: { 'X-Forwarded-For': IP_BOB } });
    assert.equal(login.status, 403, 'حساب هنوز بن است');
    assert.match(login.body.message, /مسدود/);

    /* رمز اشتباه همان ۴۰۱ همیشگی است — وضعیت بن لو نمی‌رود */
    const wrong = await anon.post('/login', { username: 'bob', password: 'wrongpass' },
        { headers: { 'X-Forwarded-For': IP_BOB } });
    assert.equal(wrong.status, 401);
    assert.notEqual(wrong.body.banned, true, 'با رمز اشتباه نباید بفهمیم حساب بن شده');

    const again = await from(admin, '5.100.1.1').del(`/api/admin/unban_ip/${encodeURIComponent(IP_BOB)}`);
    assert.equal(again.status, 404, 'نشانیِ تکراری در فهرست نیست');
});

test('رفع بن کاربر با بازگرداندن نشانی، دسترسی کامل را برمی‌گرداند', async () => {
    /* اول دوباره نشانی‌اش را می‌بندیم تا حالت کامل سنجیده شود */
    await from(admin, '5.100.1.1').post('/api/admin/ban_ip', { ip: IP_BOB, reason: 'دوباره' });
    const r = await from(admin, '5.100.1.1').post(`/api/admin/unban_user/${bob.user.id}`, { unban_ip: true });
    assert.equal(r.body.success, true);
    assert.equal(r.body.unbanned_ip, IP_BOB);
    assert.equal(r.body.user.banned, false);

    const fresh = srv.client();
    const login = await loginFrom(fresh, 'bob', 'bobpass1', IP_BOB);
    assert.equal(login.status, 200, 'bob باید بتواند دوباره وارد شود');
    const users = await from(fresh, IP_BOB).get('/users');
    assert.equal(users.status, 200);
});

test('بن با CIDR: کل محدوده بسته می‌شود، نه فقط یک IP', async () => {
    const r = await from(admin, '5.100.1.1').post(`/api/admin/ban_user/${carol.user.id}`, { reason: 'مزاحمت', cidr: 24 });
    assert.equal(r.body.success, true, JSON.stringify(r.body));
    assert.equal(r.body.banned_ip, '2.178.45.0/24', 'باید شبکهٔ /24 بسته شود نه تک IP');

    /* یک IP دیگر در همان محدوده — هرگز وارد هم نشده بود */
    const stranger = srv.client();
    const blocked = await stranger.post('/login', { username: 'carol', password: 'carolpass1' },
        { headers: { 'X-Forwarded-For': '2.178.45.200' } });
    assert.equal(blocked.status, 403, 'همهٔ محدوده باید بسته باشد');

    /* ولی محدودهٔ مجاور باز است — بن نباید بیشتر از حد ببندد */
    const neighbor = srv.client();
    const okNeighbor = await neighbor.post('/login', { username: 'root', password: 'rootpass1' },
        { headers: { 'X-Forwarded-For': '2.178.46.1' } });
    assert.equal(okNeighbor.status, 200, 'محدودهٔ مجاور نباید بسته شود');

    /* مدیر نشانی را باز می‌کند و carol را رفع بن می‌کند */
    await from(admin, '5.100.1.1').del(`/api/admin/unban_ip/${encodeURIComponent('2.178.45.0/24')}`);
    await from(admin, '5.100.1.1').post(`/api/admin/unban_user/${carol.user.id}`, { unban_ip: false });
    const back = await loginFrom(srv.client(), 'carol', 'carolpass1', IP_CAROL);
    assert.equal(back.status, 200, 'carol باید برگردد');
});

test('بنِ دستی نشانی و فهرست نهایی', async () => {
    const r = await from(admin, '5.100.1.1').post('/api/admin/ban_ip', { ip: '185.12.34.56', reason: 'ربات' });
    assert.equal(r.body.success, true);
    assert.equal(r.body.ip, '185.12.34.56');

    const list = await from(admin, '5.100.1.1').get('/api/admin/banned_ips');
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].ip, '185.12.34.56');

    /* IP با نگاشت ::ffff هم همان IP است — نباید دو جور شمرده شود */
    const v6ish = srv.client();
    const blocked = await v6ish.get('/api/app_info', { headers: { 'X-Forwarded-For': '185.12.34.56' } });
    assert.equal(blocked.status, 403);

    await from(admin, '5.100.1.1').del(`/api/admin/unban_ip/${encodeURIComponent('185.12.34.56')}`);
    assert.equal((await from(admin, '5.100.1.1').get('/api/admin/banned_ips')).body.length, 0);
});

test.after(async () => {
    if (srv) await srv.close();
    delete process.env.JVL_TRUST_PROXY;
});
