'use strict';

/**
 * آمادهٔ Pages بودن: صفحهٔ استاتیک باید بدون سرور کار کند.
 * اینجا خودِ لایهٔ MQTT در محیط شبه‌مرورگر (بدون بروکر) بارگذاری می‌شود.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SHIM = path.join(ROOT, 'static', 'js', 'mqtt-backend.js');

test('index.html هیچ مسیر مطلق /static یا /files ندارد (زیردامنهٔ Pages)', () => {
    assert.equal(/["'(]\/static\//.test(HTML), false, 'مسیر مطلق /static پیدا شد');
    assert.equal(/["'`]\/files\//.test(HTML), false, 'مسیر مطلق /files پیدا شد');
});

test('index.html هر دو اسکریپت MQTT را با مسیر نسبی بارگذاری می‌کند', () => {
    assert.match(HTML, /<script src="static\/js\/mqtt\.min\.js"><\/script>/);
    assert.match(HTML, /<script src="static\/js\/mqtt-backend\.js"><\/script>/);
    /* لایهٔ MQTT باید پیش از اسکریپت اصلی صفحه بیاید تا fetch را زودتر بگیرد */
    assert.ok(HTML.indexOf('static/js/mqtt-backend.js') < HTML.indexOf('const APP_VERSION'),
        'mqtt-backend.js باید قبل از اسکریپت اصلی صفحه باشد');
});

test('همهٔ دارایی‌های استاتیک که صفحه می‌خواهد در مخزن هستند', () => {
    const needed = [
        'static/js/mqtt.min.js',
        'static/js/mqtt-backend.js',
        'static/fonts/Vazirmatn-Regular.woff2',
        'static/fonts/Vazirmatn-Medium.woff2',
        'static/fonts/Vazirmatn-Bold.woff2',
        'static/fonts/Vazirmatn-Black.woff2'
    ];
    for (const f of needed) {
        assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} وجود ندارد`);
        assert.ok(fs.statSync(path.join(ROOT, f)).size > 1000, `${f} خالی است`);
    }
});

/* ───────── رفتار لایهٔ MQTT در محیط شبه‌مرورگر ───────── */

function loadShimInFakeBrowser() {
    const mem = new Map();
    globalThis.localStorage = {
        getItem: k => (mem.has(k) ? mem.get(k) : null),
        setItem: (k, v) => mem.set(k, String(v)),
        removeItem: k => mem.delete(k)
    };
    globalThis.location = { pathname: '/JVL.PLATFORM/index.html' };
    globalThis.document = {
        createElement: () => ({ set src(v) { this._src = v; }, get src() { return this._src; } }),
        head: { appendChild: () => {} }
    };
    delete require.cache[require.resolve(SHIM)];
    return require(SHIM);
}

let JVL;

test.before(async () => { JVL = loadShimInFakeBrowser(); });

test('وقتی سروری پشت صفحه نیست، حالت MQTT انتخاب می‌شود', async () => {
    const res = await JVL.__test.jvlFetch('/api/app_info', { method: 'GET' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.transport, 'mqtt');
    assert.equal(body.version, '4.0.0');
    assert.equal(JVL.mode(), 'mqtt');
});

test('پیشوند زیردامنهٔ Pages از مسیرها حذف می‌شود', async () => {
    const withPrefix = await JVL.__test.jvlFetch('/JVL.PLATFORM/api/app_info', { method: 'GET' });
    assert.equal(withPrefix.status, 200);
    const unknown = await JVL.__test.jvlFetch('/JVL.PLATFORM/api/does-not-exist', { method: 'GET' });
    assert.equal(unknown.status, 404);
});

test('mediaURL: data URL دست‌نخورده و نام فایل با پیشوند /files', () => {
    const data = 'data:image/jpeg;base64,/9j/4AAQ';
    assert.equal(JVL.mediaURL('chat', data), data);
    assert.equal(JVL.mediaURL('posts', 'abc 123.png'), '/JVL.PLATFORM/files/posts/abc%20123.png');
    assert.equal(JVL.mediaURL('chat', null), '');
    assert.equal(JVL.mediaURL('chat', ''), '');
});

test('بدون نشست ۴۰۱ و با مسیر نامعتبر خطای خوانا', async () => {
    const r = await JVL.__test.jvlFetch('/users', { method: 'GET' });
    assert.equal(r.status, 401);
    const bad = await JVL.__test.jvlFetch('/create_lan_host', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    assert.equal(bad.status, 401, 'بدون ورود نباید اجازهٔ ثبت هاست داد');
});

test('io() سوکتی با همان ظاهر socket.io می‌دهد', () => {
    const s = globalThis.io();
    assert.equal(typeof s.on, 'function');
    assert.equal(typeof s.emit, 'function');
    assert.equal(typeof s.disconnect, 'function');
});
