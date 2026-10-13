'use strict';

/**
 * تست مرورگری: خودِ index.html با jsdom بالا می‌آید و روی یک بروکر واقعی
 * (aedes) کار می‌کند. این تست «قفل شدن صفحه» را بازتولید می‌کند: اگر لایهٔ
 * MQTT حلقهٔ بازخورد join↔connect بسازد، پوستهٔ برنامه هرگز باز نمی‌شود.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { JSDOM, VirtualConsole } = require('jsdom');
const WS = require('ws');
const { Aedes } = require('aedes');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/*
 * jsdom ۳۰ دیگر ResourceLoader ندارد، پس اسکریپت‌های بیرونی را خودمان داخل
 * HTML می‌گذاریم. باندل مرورگری mqtt.min.js با ماژول `ws` نود سازگار نیست
 * (realm متفاوت برای Uint8Array)، پس جای آن بیلد نود mqtt را تزریق می‌کنیم؛
 * منطق خودمان (mqtt-backend.js + index.html) دقیقاً همان چیزی است که تست می‌شود.
 */
function inlineScripts(html) {
    return html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => {
        if (src.includes('mqtt.min.js')) return '<script>/* mqtt از بیرون تزریق شد */</script>';
        const file = path.join(ROOT, src);
        if (!fs.existsSync(file)) throw new Error('اسکریپت پیدا نشد: ' + src);
        return '<script>\n' + fs.readFileSync(file, 'utf8') + '\n</script>';
    });
}

let broker;
let httpServer;
let wss;
let brokerUrl;
const openWindows = [];

function patchWindow(win, networkKey, fetchLog) {
    win.WebSocket = WS;
    win.mqtt = require('mqtt');
    win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    win.scrollTo = () => {};
    win.URL.createObjectURL = () => 'blob:stub';
    win.URL.revokeObjectURL = () => {};
    Object.defineProperty(win.navigator, 'mediaDevices', {
        value: { getUserMedia: () => Promise.reject(new Error('میکروفون در تست نیست')), enumerateDevices: () => Promise.resolve([]) },
        configurable: true
    });
    win.localStorage.setItem('jvl_broker', brokerUrl);
    win.localStorage.setItem('jvl_network', networkKey);
}

async function openPage(networkKey) {
    const errors = [];
    const fetchLog = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', e => errors.push('jsdomError: ' + String(e.message).slice(0, 160)));
    virtualConsole.on('error', (...a) => errors.push('console.error: ' + String(a.join(' ')).slice(0, 160)));

    const dom = new JSDOM(inlineScripts(HTML), {
        url: 'https://javadxpro.github.io/JVL.PLATFORM/index.html',
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        virtualConsole,
        beforeParse: win => patchWindow(win, networkKey, fetchLog)
    });
    await new Promise(r => dom.window.addEventListener('load', r, { once: true }));
    /*
     * شمارش درخواست‌ها: حلقهٔ بی‌نهایت خود را اینجا لو می‌دهد. بعد از load
     * نصب می‌شود، چون تا آن موقع لایهٔ MQTT جای window.fetch را گرفته است.
     */
    const realFetch = dom.window.fetch.bind(dom.window);
    dom.window.fetch = function (...args) { fetchLog.push(String(args[0])); return realFetch(...args); };
    openWindows.push(dom.window);
    return { dom, win: dom.window, errors, fetchLog };
}

const settle = (ms = 120) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, ms = 15000, label = '') {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        let v = null;
        try { v = await fn(); } catch { v = null; }
        if (v) return v;
        await settle();
    }
    throw new Error('مهلت انتظار تمام شد: ' + label);
}

test.before(async () => {
    broker = await Aedes.createBroker();
    httpServer = http.createServer();
    wss = new WS.Server({ server: httpServer });
    wss.on('connection', s => broker.handle(WS.createWebSocketStream(s)));
    await new Promise(r => httpServer.listen(0, '127.0.0.1', r));
    brokerUrl = `ws://127.0.0.1:${httpServer.address().port}/mqtt`;
});

test.after(async () => {
    /* کلاینت MQTT هر صفحه را ببند، وگرنه reconnect باز می‌ماند و پروسه تمام نمی‌شود */
    for (const w of openWindows) { try { w.JVL && w.JVL.shutdown(); } catch { /* ignore */ } }
    for (const w of openWindows) { try { w.close(); } catch { /* ignore */ } }
    try { wss.close(); } catch { /* ignore */ }
    try { httpServer.close(); } catch { /* ignore */ }
    try { await new Promise(r => broker.close(r)); } catch { /* ignore */ }
});

test('صفحه بالا می‌آید، لایهٔ MQTT فعال است و نوار بالا همهٔ بخش‌ها را دارد', async () => {
    const { win, errors } = await openPage('brz-boot');

    assert.equal(typeof win.JVL, 'object', 'لایهٔ MQTT نصب نشد');
    assert.equal(typeof win.mediaURL, 'function', 'mediaURL تعریف نشد');
    assert.ok(await waitFor(() => win.JVL.mode() === 'mqtt', 8000, 'mode=mqtt'), 'حالت mqtt انتخاب نشد');

    /* نوار بالای صفحه باید همهٔ بخش‌ها را داشته باشد */
    const topbar = win.document.getElementById('topbar');
    assert.ok(topbar, 'عنصر #topbar در صفحه نیست');
    const tabs = [...topbar.querySelectorAll('[data-tab]')].map(e => e.dataset.tab);
    for (const need of ['chat', 'explore', 'profile']) {
        assert.ok(tabs.includes(need), `بخش «${need}» در نوار بالا نیست (دارد: ${tabs.join(', ')})`);
    }
    /* نوار پایین باید حذف شده باشد تا دوباره تکراری نشود */
    assert.equal(win.document.getElementById('bottomNav'), null, 'نوار پایین هنوز هست');
    assert.deepEqual(errors, [], 'خطای جاوااسکریپت هنگام بالا آمدن: ' + errors.join(' | '));
});

test('ثبت‌نام و ورود صفحه را باز می‌کند و حلقهٔ بی‌نهایت درخواست نمی‌زند', async () => {
    const { win, errors, fetchLog } = await openPage('brz-login');
    await waitFor(() => win.JVL && win.JVL.state.ready(), 15000, 'اتصال به بروکر');

    const set = (id, v) => { win.document.getElementById(id).value = v; };

    set('authUsername', 'sara'); set('authPassword', 'pass1234');
    win.register();
    await waitFor(() => /مدیر/.test(win.document.body.textContent), 15000, 'پیام ساخت حساب');

    set('authUsername', 'sara'); set('authPassword', 'pass1234');
    const before = fetchLog.length;
    win.login();

    /* این همان asserts بازگشتی قفل‌شدن است */
    assert.ok(await waitFor(() => win.document.getElementById('appShell').style.display === 'flex', 15000, 'باز شدن پوستهٔ برنامه'),
        'پوستهٔ برنامه باز نشد — صفحه قفل است');
    assert.equal(win.document.getElementById('authPage').style.display, 'none');
    assert.ok(win.localStorage.getItem('volexturn_token'), 'توکن ذخیره نشد');

    /* دو ثانیه صبر؛ اگر حلقهٔ بازخورد برگردد، شمار درخواست‌ها منفجر می‌شود */
    await settle(2000);
    const after = fetchLog.length;
    assert.ok(after - before < 60, `حلقهٔ بی‌نهایت درخواست: ${after - before} درخواست در ۲ ثانیه`);

    const counts = {};
    for (const f of fetchLog.slice(before)) counts[f] = (counts[f] || 0) + 1;
    for (const [url, n] of Object.entries(counts)) {
        assert.ok(n <= 8, `${url} ${n} بار صدا زده شد (حلقهٔ بازخورد)`);
    }
    assert.deepEqual(errors, [], 'خطای جاوااسکریپت هنگام ورود: ' + errors.join(' | '));
});

test('کاربر دوم می‌تواند کاربر اول را آنلاین ببیند', async () => {
    const key = 'brz-two';
    const a = await openPage(key);
    const b = await openPage(key);

    for (const [pg, name] of [[a, 'ali'], [b, 'reza']]) {
        await waitFor(() => pg.win.JVL && pg.win.JVL.state.ready(), 15000, 'اتصال ' + name);
        pg.win.document.getElementById('authUsername').value = name;
        pg.win.document.getElementById('authPassword').value = 'pass1234';
        pg.win.register();
        await settle(700);
        pg.win.document.getElementById('authUsername').value = name;
        pg.win.document.getElementById('authPassword').value = 'pass1234';
        pg.win.login();
        await waitFor(() => pg.win.document.getElementById('appShell').style.display === 'flex', 15000, 'ورود ' + name);
    }

    await waitFor(async () => {
        const r = await a.win.fetch('/users');
        const list = await r.json();
        return list.length >= 2 && list.some(u => u.username === 'reza' && u.is_online === true);
    }, 15000, 'دیدن reza به‌صورت آنلاین');

    assert.deepEqual(a.errors, [], 'خطای صفحهٔ اول: ' + a.errors.join(' | '));
    assert.deepEqual(b.errors, [], 'خطای صفحهٔ دوم: ' + b.errors.join(' | '));
});
