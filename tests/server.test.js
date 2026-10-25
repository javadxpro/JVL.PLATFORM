'use strict';

/**
 * تست یکپارچهٔ خودِ سرور: صفحهٔ اصلی، دارایی‌های استاتیک، سوکت و مسیر فایل‌ها.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'jvl-server-'));
process.env.JVL_DATA_DIR = DATA;
process.env.JVL_QUIET = '1';

const { startServer } = require('../server/index');
const Config = require('../server/config');

let base;
let serverRef;

test.before(async () => {
    const { server } = startServer({ port: 0, host: '127.0.0.1' });
    serverRef = server;
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

test('صفحهٔ اصلی همان index.html مخزن است', async () => {
    const r = await fetch(base + '/');
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.match(text, /Volexturn/);
    assert.equal(text, fs.readFileSync(Config.indexHtml, 'utf8'));
});

test('مسیر ناشناختهٔ غیر API هم صفحه را برمی‌گرداند', async () => {
    const r = await fetch(base + '/some/deep/page');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<div class="auth-page"/);
});

test('کلاینت socket.io سرو می‌شود', async () => {
    const r = await fetch(base + '/static/js/socket.io.min.js');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /javascript/);
    assert.ok((await r.text()).length > 1000);
});

test('فونت‌های وزیرمتن سرو می‌شوند', async () => {
    for (const f of ['Regular', 'Medium', 'Bold', 'Black']) {
        const r = await fetch(base + `/static/fonts/Vazirmatn-${f}.woff2`);
        assert.equal(r.status, 200, f);
        assert.match(r.headers.get('content-type') || '', /font\/woff2/);
    }
    /* نام فایل فقط باید woff/woff2 باشد؛ هر چیز دیگری ۴۰۰ می‌گیرد */
    assert.equal((await fetch(base + '/static/fonts/package.json')).status, 400);
    assert.equal((await fetch(base + '/static/fonts/..%2F..%2Fpackage.json')).status, 400);
    assert.equal((await fetch(base + '/static/fonts/Vazirmatn-Regular.ttf')).status, 400, 'پسوند غیرمجاز → ۴۰۰');
    assert.equal((await fetch(base + '/static/fonts/Vazirmatn-Thin.woff2')).status, 200, 'وزن موجود در پکیج فونت');
    assert.equal((await fetch(base + '/static/fonts/Vazirmatn-Nope.woff2')).status, 404, 'فونت ناموجود → ۴۰۴');
});

test('هندشیک socket.io کار می‌کند', async () => {
    const r = await fetch(base + '/socket.io/?EIO=4&transport=polling');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /"sid"/);
});

test('فایل ناموجود و تلاش برای فرار از پوشه → ۴۰۴', async () => {
    assert.equal((await fetch(base + '/files/chat/nope.png')).status, 404);
    assert.equal((await fetch(base + '/files/evil/x.png')).status, 404);
    assert.equal((await fetch(base + '/files/chat/..%2F..%2Fsecret.key')).status, 404);
    assert.equal((await fetch(base + '/files/profiles/.hidden')).status, 404);
});

test('api/health نسخه را برمی‌گرداند', async () => {
    const r = await fetch(base + '/api/health');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.version, Config.app_version);
});

test.after(async () => {
    if (serverRef) await new Promise(r => serverRef.close(r));
    fs.rmSync(DATA, { recursive: true, force: true });
});
