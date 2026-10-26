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
    /*
     * jsdom پیاده‌سازی Notification ندارد. یک استاب با حافظه می‌گذاریم تا
     * بتوانیم بفهمیم صفحه واقعاً اعلان داده یا نه. serviceWorker هم نیست،
     * پس notifyOS به سازندهٔ ساده می‌افتد — همان مسیر پشتیبانِ واقعی.
     */
    const shown = [];
    win.__notifications = shown;
    class NotifStub {
        constructor(title, opts) { shown.push({ title, opts: opts || {}, via: 'ctor' }); }
        close() {}
    }
    NotifStub.permission = 'default';
    NotifStub.requestPermission = () => { NotifStub.permission = 'granted'; return Promise.resolve('granted'); };
    win.Notification = NotifStub;
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



/* ───────── ابزار تماس ───────── */

/**
 * RTCPeerConnection ساختگی: کل دست‌دادن offer/answer/ICE را مثل مرورگر طی
 * می‌کند تا مسیر سیگنالینگ صفحه واقعاً اجرا شود. «اتصال» وقتی فرض می‌شود
 * که یک طرف answer را گرفته باشد.
 */
function installMockRTC(win, log) {
    class MockStream {
        constructor() { this._t = [{ enabled: true, stop() {}, kind: 'audio' }]; }
        getTracks() { return this._t; }
        getAudioTracks() { return this._t; }
        getVideoTracks() { return []; }
    }
    Object.defineProperty(win.navigator, 'mediaDevices', {
        value: { getUserMedia: () => Promise.resolve(new MockStream()), enumerateDevices: () => Promise.resolve([]) },
        configurable: true
    });
    class MockPC {
        constructor(cfg) {
            this.cfg = cfg; this.localDescription = null; this.remoteDescription = null;
            this.connectionState = 'new';
            log.push('pc-new:' + (cfg.iceServers || []).length + '-ice');
        }
        addTrack() {}
        async createOffer() { this.localDescription = { type: 'offer', sdp: 'mock-sdp-offer' }; return this.localDescription; }
        async createAnswer() { this.localDescription = { type: 'answer', sdp: 'mock-sdp-answer' }; return this.localDescription; }
        async setLocalDescription(d) {
            this.localDescription = d;
            log.push('setLocal:' + d.type);
            /* سمت پاسخ‌دهنده: بعد از ساخت answer، رسانه وصل می‌شود */
            if (d.type === 'answer' && this.remoteDescription) this._connect();
            if (this.onicecandidate) setTimeout(() => this.onicecandidate({ candidate: { candidate: 'mock-ice', sdpMid: '0', sdpMLineIndex: 0 } }), 0);
        }
        async setRemoteDescription(d) {
            this.remoteDescription = d;
            log.push('setRemote:' + d.type);
            if (d.type === 'answer') this._connect();
        }
        async addIceCandidate(c) { log.push('addIce'); }
        _connect() {
            if (this.connectionState === 'connected') return;
            this.connectionState = 'connected';
            if (this.onconnectionstatechange) this.onconnectionstatechange();
            if (this.ontrack) this.ontrack({ streams: [new MockStream()] });
        }
        close() { this.connectionState = 'closed'; log.push('pc-close'); }
    }
    win.RTCPeerConnection = MockPC;
    /* AudioContext برای بوق تماس */
    win.AudioContext = class {
        constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
        createOscillator() { return { frequency: { value: 0 }, type: '', connect() {}, start() {}, stop() {} }; }
        createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
        resume() {}
    };
}

async function openChat(pg, peerId) {
    const list = await (await pg.win.fetch('/users')).json();
    const u = list.find(x => x.id === peerId);
    if (!u) throw new Error('کاربر پیدا نشد: ' + peerId);
    /* selectUser را صدا می‌زنیم چون selectedUserId یک بایندینگ let داخل
       اسکریپت صفحه است و از بیرون قابل ست‌شدن نیست */
    pg.win.selectUser(u);
    await settle(400);
}

/* ───────── ابزار رسانه ───────── */

/** دو صفحه روی یک شبکه، هر دو واردشده */
async function twoLoggedIn(key, names) {
    const pages = [];
    for (const name of names) {
        const pg = await openPage(key);
        pages.push(pg);
        await waitFor(() => pg.win.JVL && pg.win.JVL.state.ready(), 15000, 'ready ' + name);
        const set = (id, v) => { pg.win.document.getElementById(id).value = v; };
        set('authUsername', name); set('authPassword', 'pass1234');
        pg.win.register();
        await settle(700);
        set('authUsername', name); set('authPassword', 'pass1234');
        pg.win.login();
        await waitFor(() => pg.win.document.getElementById('appShell').style.display === 'flex', 15000, 'ورود ' + name);
    }
    return pages;
}

/** شناسهٔ کاربر از روی نام */
async function userId(pg, username) {
    const r = await pg.win.fetch('/users');
    const list = await r.json();
    const u = list.find(x => x.username === username);
    if (!u) throw new Error('کاربر پیدا نشد: ' + username);
    return u.id;
}

/** فایل ساختگی با بایت‌های قابل تشخیص */
function fakeFile(win, name, type, bytes) {
    const buf = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) buf[i] = (i * 7 + 13) % 251;
    return new win.File([buf], name, { type });
}

async function sendFile(pg, receiverId, file) {
    const fd = new pg.win.FormData();
    fd.append('receiver_id', String(receiverId));
    fd.append('file', file);
    const r = await pg.win.fetch('/send_message', { method: 'POST', body: fd });
    return { status: r.status, body: await r.json() };
}

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

test('عکس کوچک در یک پیام می‌رسد (بدون تکه‌تکه‌شدن)', async () => {
    const [a, b] = await twoLoggedIn('brz-img', ['mona', 'kia']);
    const kia = await userId(a, 'kia');
    const file = fakeFile(a.win, 'shot.png', 'image/png', 40 * 1024);

    const res = await sendFile(a, kia, file);
    assert.equal(res.status, 200, 'ارسال عکس شکست: ' + JSON.stringify(res.body));
    assert.equal(res.body.success, true, JSON.stringify(res.body));
    const fp = res.body.message.file_path;
    assert.ok(String(fp).startsWith('data:image/png'), 'عکس باید data URL باشد، هست: ' + String(fp).slice(0, 30));

    /* سمت گیرنده هم همان data URL را می‌بیند (بخش peer = فرستنده) */
    const mona = await userId(b, 'mona');
    await waitFor(async () => {
        const r = await b.win.fetch(`/messages/0/${mona}`);
        const list = await r.json();
        return list.length && list[list.length - 1].file_path === fp;
    }, 15000, 'رسیدن عکس به گیرنده');
    assert.deepEqual(a.errors, [], 'خطا: ' + a.errors.join(' | '));
});

test('ویدیو تکه‌تکه فرستاده می‌شود و گیرنده همان بایت‌ها را بازسازی می‌کند', async () => {
    const [a, b] = await twoLoggedIn('brz-vid', ['saman', 'neda']);
    const neda = await userId(a, 'neda');

    /* ۱٫۵MB → base64 حدود ۲MB، پس حتماً از مسیر تکه‌تکه می‌رود (۱۷ تکه) */
    const file = fakeFile(a.win, 'clip.mp4', 'video/mp4', 1536 * 1024);
    const res = await sendFile(a, neda, file);
    assert.equal(res.status, 200, 'ارسال ویدیو شکست: ' + JSON.stringify(res.body));
    const fp = String(res.body.message.file_path);
    assert.match(fp, /^media:[a-z0-9]+$/, 'ویدیو باید ارجاع media:<id> باشد، هست: ' + fp.slice(0, 24));
    assert.equal(res.body.message.file_type, 'video');

    /* فرستنده فوراً مدیای خودش را دارد */
    assert.ok(a.win.mediaURL('chat', fp).startsWith('data:video/mp4;base64,'), 'فرستنده مدیا را ندارد');

    /* گیرنده: اول خالی (در انتظار)، بعد data URL کامل */
    const saman = await userId(b, 'saman');
    const got = await waitFor(async () => {
        const r = await b.win.fetch(`/messages/0/${saman}`);
        const list = await r.json();
        const m = list[list.length - 1];
        if (!m) return null;
        const url = b.win.mediaURL('chat', m.file_path);
        return url.startsWith('data:video/mp4;base64,') ? url : null;
    }, 25000, 'بازسازی ویدیو سمت گیرنده');

    /* بایت‌به‌بایت با اصل یکی باشد */
    const mine = a.win.mediaURL('chat', fp);
    assert.equal(got.length, mine.length, 'طول مدیای بازسازی‌شده فرق دارد');
    assert.equal(got, mine, 'محتوای ویدیو با اصل نمی‌خواند');
    assert.deepEqual(b.errors, [], 'خطای گیرنده: ' + b.errors.join(' | '));
});

test('ویدیو برای استوری رد می‌شود و پیام روشن می‌دهد', async () => {
    const [a] = await twoLoggedIn('brz-story', ['tara']);
    const fd = new a.win.FormData();
    fd.append('file', fakeFile(a.win, 'clip.mp4', 'video/mp4', 60 * 1024));
    const r = await a.win.fetch('/create_story', { method: 'POST', body: fd });
    const body = await r.json();
    assert.equal(body.success, false);
    assert.match(body.message, /ویدیو فقط در چت/);
});

test('فایل بزرگ‌تر از سقفِ لایه رد می‌شود و پیام روشن می‌دهد', async () => {
    const [a, b] = await twoLoggedIn('brz-big', ['omid', 'roza']);
    const roza = await userId(a, 'roza');
    const info = await (await a.win.fetch('/api/app_info')).json();
    const limit = info.limits.video;
    assert.ok(limit > 0, 'سقف ویدیو باید در app_info اعلام شود');

    const fd = new a.win.FormData();
    fd.append('receiver_id', String(roza));
    fd.append('file', fakeFile(a.win, 'huge.mp4', 'video/mp4', limit + 1024 * 1024));
    const body = await (await a.win.fetch('/send_message', { method: 'POST', body: fd })).json();
    assert.equal(body.success, false);
    assert.match(body.message, /حجم فایل بیشتر از/);
});

test('تماس صوتی: سیگنال کامل offer/answer روی MQTT رد و بدل می‌شود', async () => {
    const logA = [], logB = [];
    const [a, b] = await twoLoggedIn('brz-call', ['hadi', 'lili']);
    installMockRTC(a.win, logA);
    installMockRTC(b.win, logB);

    const lili = await userId(a, 'lili');
    const hadi = await userId(b, 'hadi');
    await openChat(a, lili);
    await openChat(b, hadi);

    /* الف تماس می‌گیرد */
    a.win.startCall(false);
    await waitFor(() => b.win.document.getElementById('callIncoming').classList.contains('on'), 15000, 'نمایش تماس ورودی سمت لیلی');
    assert.equal(b.win.document.getElementById('ciName').textContent, 'hadi');

    /* لیلی پاسخ می‌دهد → offer/answer کامل می‌شود */
    b.win.answerCall();
    const remoteOf = (pg) => pg.win.document.getElementById('remoteVideo').srcObject;
    await waitFor(() => a.win.document.getElementById('callOverlay').classList.contains('on') && remoteOf(a), 15000, 'متصل‌شدن سمت تماس‌گیرنده');
    await waitFor(() => remoteOf(b), 15000, 'متصل‌شدن سمت پاسخ‌دهنده');

    /* مسیر واقعی WebRTC طی شده باشد */
    assert.ok(logA.includes('pc-new:3-ice') || /pc-new:\d+-ice/.test(logA.join(' ')), 'RTCPeerConnection سمت الف ساخته نشد: ' + logA.join(','));
    assert.ok(logA.includes('setRemote:answer'), 'الف answer نگرفت: ' + logA.join(','));
    assert.ok(logB.includes('setRemote:offer'), 'لیلی offer نگرفت: ' + logB.join(','));
    assert.ok(logA.includes('addIce') || logB.includes('addIce'), 'نامزد ICE رد و بدل نشد');
    assert.match(a.win.document.getElementById('callState').textContent, /متصل|\d/, 'وضعیت تماس به‌روز نشد');

    /* قطع از یک طرف، هر دو را پاک می‌کند */
    a.win.endCall();
    await waitFor(() => !b.win.document.getElementById('callOverlay').classList.contains('on'), 15000, 'پاک‌شدن تماس سمت لیلی');
    assert.equal(a.win.document.getElementById('callOverlay').classList.contains('on'), false);
    assert.deepEqual(a.errors, [], 'خطای الف: ' + a.errors.join(' | '));
    assert.deepEqual(b.errors, [], 'خطای لیلی: ' + b.errors.join(' | '));
});

test('تماس ورودی را می‌شود رد کرد و طرف مقابل می‌فهمد', async () => {
    const logA = [], logB = [];
    const [a, b] = await twoLoggedIn('brz-reject', ['arma', 'ghazal']);
    installMockRTC(a.win, logA); installMockRTC(b.win, logB);
    const ghazal = await userId(a, 'ghazal');
    await openChat(a, ghazal);

    a.win.startCall(true);
    await waitFor(() => b.win.document.getElementById('callIncoming').classList.contains('on'), 15000, 'تماس ورودی');
    b.win.rejectCall();
    await waitFor(() => !a.win.document.getElementById('callOverlay').classList.contains('on'), 15000, 'پاک‌شدن تماس بعد از رد');
    assert.equal(b.win.document.getElementById('callIncoming').classList.contains('on'), false);
});

test('همسان‌سازی مخاطبین: شمارهٔ ثبت‌شده با هر سه شکل نوشتن پیدا می‌شود', async () => {
    const [a, b] = await twoLoggedIn('brz-phone', ['yasin', 'paria']);

    /* یاسین شماره‌اش را ثبت می‌کند */
    const saved = await (await a.win.fetch('/set_phone', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '09121234567' })
    })).json();
    assert.equal(saved.success, true, JSON.stringify(saved));

    /*
     * پیام retained باید به کاربر دوم برسد؛ مثل دنیای واقعی کمی طول می‌کشد.
     */
    const lookup = async (win, phone) => (await win.fetch('/contacts_lookup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes: [phone] })
    })).json();
    await waitFor(async () => (await lookup(b.win, '09121234567')).matches.length === 1, 15000, 'رسیدن هش شماره به کاربر دوم');

    /* پریا با چهار شکل نوشتنِ همان شماره جست‌وجو می‌کند */
    for (const variant of ['09121234567', '+989121234567', '989121234567', '00989121234567']) {
        const res = await lookup(b.win, variant);
        assert.equal(res.matches.length, 1, `شمارهٔ ${variant} پیدا نشد`);
        assert.equal(res.matches[0].username, 'yasin');
    }

    /* شمارهٔ ناشناس باید خالی برگردد و شمارهٔ خام هرگز منتشر نشود */
    assert.equal((await lookup(b.win, '09351110000')).matches.length, 0, 'شمارهٔ ناشناس باید خالی برگردد');

    /* کاربر نباید شمارهٔ خودش را به‌عنوان مخاطب ببیند */
    assert.equal((await lookup(a.win, '09121234567')).matches.length, 0, 'شمارهٔ خود کاربر باید فیلتر شود');

    /* هیچ تاپیکی با شمارهٔ خام ساخته نشده باشد */
    const topics = a.win.JVL.state.topics ? a.win.JVL.state.topics() : [];
    for (const t of topics) assert.ok(!/9121234567/.test(t), 'شمارهٔ خام روی MQTT رفت: ' + t);
    assert.deepEqual(a.errors, [], 'خطا: ' + a.errors.join(' | '));
});

test('کانال: مالک منتشر می‌کند، مشترک می‌خواند و نظر می‌دهد', async () => {
    const [a, b] = await twoLoggedIn('dbg-chan', ['amin', 'bahar']);

    /* مالک کانال می‌سازد */
    const created = await (await a.win.fetch('/create_channel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'اخبار فناوری', bio: 'تازه‌های دنیای tech' })
    })).json();
    assert.equal(created.success, true, JSON.stringify(created));
    const cid = created.channel_id;
    assert.equal(created.channel.is_owner, true, 'سازنده باید مالک باشد');
    assert.equal(created.channel.subscribed, true, 'مالک خودش مشترک است');

    /* کانال روی MQTT به کاربر دوم می‌رسد */
    const channelsOf = async (w) => (await w.fetch('/channels')).json();
    await waitFor(async () => (await channelsOf(b.win)).some(c => c.id === cid), 15000, 'رسیدن کانال به کاربر دوم');
    const seen = (await channelsOf(b.win)).find(c => c.id === cid);
    assert.equal(seen.name, 'اخبار فناوری');
    assert.equal(seen.owner_name, 'amin', 'نام مالک باید از روی user doc بیاید');
    assert.equal(seen.is_owner, false);
    assert.equal(seen.subscribed, false);

    /* عضویت */
    const sub = await (await b.win.fetch('/channel_subscribe/' + cid, { method: 'POST' })).json();
    assert.equal(sub.success, true);
    assert.equal(sub.subscribed, true);
    assert.equal(sub.subscribers, 2, 'مالک + یک مشترک');

    /* غیرمالک حق انتشار ندارد */
    const denied = await (await b.win.fetch('/channel_post/' + cid, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'من هم می‌خواهم پست بگذارم' })
    })).json();
    assert.equal(denied.success, false, 'غیرمالک باید رد شود');

    /* مالک منتشر می‌کند */
    const posted = await (await a.win.fetch('/channel_post/' + cid, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'نسخهٔ جدید منتشر شد 🚀' })
    })).json();
    assert.equal(posted.success, true, JSON.stringify(posted));
    const pid = posted.post.id;

    /* مشترک همان پست را می‌بیند */
    const postsOf = async (w) => (await w.fetch('/channel_posts/' + cid)).json();
    await waitFor(async () => (await postsOf(b.win)).some(p => p.id === pid), 15000, 'رسیدن پست به مشترک');
    const got = (await postsOf(b.win)).find(p => p.id === pid);
    assert.equal(got.content, 'نسخهٔ جدید منتشر شد 🚀');
    assert.equal(got.viewed_by_me, false, 'هنوز بازدید نشمرده شده');

    /* بازدید شمرده می‌شود و تکراری شمارش نمی‌شود */
    const v1 = await (await b.win.fetch('/channel_view/' + pid, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel_id: cid })
    })).json();
    const v2 = await (await b.win.fetch('/channel_view/' + pid, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel_id: cid })
    })).json();
    assert.equal(v1.views, 1, 'اولین بازدید');
    assert.equal(v2.views, 1, 'بازدید تکراری نباید بشمارد');

    /* نظر زیر پست */
    const cmt = await (await b.win.fetch('/channel_comment/' + pid, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'عالی بود 👌', channel_id: cid })
    })).json();
    assert.equal(cmt.success, true);
    const cmts = await (await b.win.fetch('/channel_comments/' + pid)).json();
    assert.equal(cmts.length, 1);
    assert.equal(cmts[0].user_name, 'bahar');
    assert.equal(cmts[0].content, 'عالی بود 👌');

    /* مالک نمی‌تواند عضویت خودش را لغو کند؛ کانالش یتیم می‌شود */
    const ownerLeave = await (await a.win.fetch('/channel_subscribe/' + cid, { method: 'POST' })).json();
    assert.equal(ownerLeave.success, false, 'مالک نباید بتواند عضویتش را لغو کند');

    /* حذف توسط غیرمالک ممنوع است */
    const delDenied = await (await b.win.fetch('/channel_delete/' + cid, { method: 'DELETE' })).json();
    assert.equal(delDenied.success, false, 'غیرمالک نباید بتواند حذف کند');

    /* حذف توسط مالک: پست‌ها، عضویت‌ها، بازدیدها و نظرها هم پاک می‌شوند */
    const del = await (await a.win.fetch('/channel_delete/' + cid, { method: 'DELETE' })).json();
    assert.equal(del.success, true);
    await waitFor(async () => !(await channelsOf(a.win)).some(c => c.id === cid), 15000, 'کانال باید ناپدید شود');
    for (const t of a.win.JVL.state.topics()) {
        assert.ok(!/\/c(post|sub|view|cmt)\//.test(t) || !t.includes('/' + cid + '/'), 'بقایای کانال پاک نشد: ' + t);
    }

    assert.deepEqual(a.errors, [], 'خطا: ' + a.errors.join(' | '));
    assert.deepEqual(b.errors, [], 'خطا: ' + b.errors.join(' | '));
});

test('تیک سه‌حالته: ارسال ← دریافت ← خوانده‌شدن', async () => {
    const [a, b] = await twoLoggedIn('dbg-ticks', ['kian', 'lili']);
    const aid = await userId(a, 'kian'), bid = await userId(b, 'lili');

    await openChat(a, bid);
    a.win.document.getElementById('chatMessageInput').value = 'سلام، حالت چطوره؟';
    a.win.sendMessage();
    await settle(400);

    const mine = () => a.win.JVL.state.msgCache.find(x => x.content === 'سلام، حالت چطوره؟');
    const m = mine();
    assert.ok(m, 'پیام در کش فرستنده ثبت نشد');
    assert.ok(!m.seen, 'پیام نباید از ابتدا خوانده باشد');

    /* گیرنده پیام را می‌گیرد و لایهٔ MQTT خودش رسید می‌فرستد */
    await waitFor(async () => {
        const got = b.win.JVL.state.msgCache.find(x => x.id === m.id);
        return !!got;
    }, 15000, 'رسیدن پیام به گیرنده');
    await waitFor(async () => !!mine().delivered, 15000, 'رسیدن رسید تحویل به فرستنده');
    assert.equal(mine().seen, false, 'تحویل‌شدن نباید جای خوانده‌شدن را بگیرد');

    /* حالا گیرنده گفتگو را باز می‌کند → خوانده شد */
    await openChat(b, aid);
    await waitFor(async () => !!mine().seen, 15000, 'خوانده‌شدن پیام');
    assert.equal(mine().delivered, true, 'رسید تحویل باید سر جایش بماند');

    assert.deepEqual(a.errors, [], 'خطا: ' + a.errors.join(' | '));
    assert.deepEqual(b.errors, [], 'خطا: ' + b.errors.join(' | '));
});

test('اعلان گوشی: پیام جدید روی نوار اعلان می‌رود، نه برای گفتگوی باز', async () => {
    const [a, b] = await twoLoggedIn('brz-notif', ['sara', 'tara']);
    const aid = await userId(a, 'sara');
    const bid = await userId(b, 'tara');

    /* کارت اعلان در تب پروفایل باید باشد */
    assert.ok(b.win.document.getElementById('notifCard'), 'کارت اعلان وجود ندارد');

    /* قبل از اجازه گرفتن، اعلان نباید فعال باشد */
    assert.equal(b.win.notifEnabled(), false, 'بدون اجازه نباید فعال باشد');
    b.win.testNotification();
    assert.equal(b.win.__notifications.length, 0, 'بدون اجازه نباید اعلان داد');

    /* کاربر دکمهٔ «روشن کردن» را می‌زند */
    await b.win.toggleNotifications();
    assert.equal(b.win.Notification.permission, 'granted');
    assert.equal(b.win.notifEnabled(), true, 'بعد از اجازه باید فعال شود');
    assert.equal(b.win.document.getElementById('notifState').textContent, 'روشن');
    assert.equal(b.win.document.getElementById('notifBtn').textContent, 'خاموش کردن');
    /* یک اعلان خوش‌آمد هم همان لحظه نشان داده می‌شود */
    assert.ok(b.win.__notifications.length >= 1, 'اعلان خوش‌آمد نشان داده نشد');

    /* سارا پیام می‌دهد؛ تارا هیچ گفتگویی باز نکرده */
    await openChat(a, bid);
    a.win.document.getElementById('chatMessageInput').value = 'سلام تارا';
    a.win.sendMessage();
    await waitFor(async () => b.win.__notifications.some(x => x.title === 'sara'), 15000, 'اعلان برای پیام جدید');

    const notif = b.win.__notifications.find(x => x.title === 'sara');
    assert.equal(notif.opts.body, 'سلام تارا');
    assert.equal(notif.opts.dir, 'rtl', 'اعلان باید راست‌به‌چپ باشد');
    assert.equal(notif.opts.lang, 'fa');
    assert.equal(notif.opts.tag, 'dm-' + aid, 'tag باید per-مخاطب باشد تا اعلان‌ها تلنبار نشوند');
    assert.equal(notif.opts.data.peer, aid, 'کلیک روی اعلان باید همان گفتگو را باز کند');

    /* حالا تارا همان گفتگو را باز می‌کند → اعلان تکراری مزاحم است */
    const count = b.win.__notifications.length;
    await openChat(b, aid);
    a.win.document.getElementById('chatMessageInput').value = 'پیام دوم';
    a.win.sendMessage();
    await waitFor(async () => b.win.JVL.state.msgCache.some(x => x.content === 'پیام دوم'), 15000, 'رسیدن پیام دوم');
    await settle(600);
    assert.equal(b.win.__notifications.length, count, 'برای گفتگوی باز نباید اعلان بدهد');

    /* خاموش کردن هم کار کند */
    await b.win.toggleNotifications();
    assert.equal(b.win.notifEnabled(), false);
    assert.equal(b.win.localStorage.getItem('jvl_notify'), null);

    assert.deepEqual(a.errors, [], 'خطا: ' + a.errors.join(' | '));
    assert.deepEqual(b.errors, [], 'خطا: ' + b.errors.join(' | '));
});

test('اعلان گوشی: تماس ورودی با نام تماس‌گیرنده اعلام می‌شود', async () => {
    const logA = [], logB = [];
    const [a, b] = await twoLoggedIn('brz-notifcall', ['omid', 'nazanin']);
    installMockRTC(a.win, logA);
    installMockRTC(b.win, logB);

    const nazanin = await userId(a, 'nazanin');
    const omid = await userId(b, 'omid');

    /* نازنین اعلان را روشن کرده ولی گفتگویی باز نکرده */
    await b.win.toggleNotifications();
    assert.equal(b.win.notifEnabled(), true);

    await openChat(a, nazanin);
    a.win.startCall(false);
    await waitFor(async () => b.win.__notifications.some(x => /^📞/.test(x.title)), 15000, 'اعلان تماس ورودی');

    const n = b.win.__notifications.find(x => /^📞/.test(x.title));
    assert.equal(n.title, '📞 omid', 'نام تماس‌گیرنده باید در اعلان باشد');
    assert.equal(n.opts.body, 'تماس صوتی ورودی');
    assert.equal(n.opts.tag, 'call');
    assert.equal(n.opts.data.peer, omid, 'کلیک روی اعلان باید به همان مخاطب ببرد');

    assert.deepEqual(b.errors, [], 'خطا: ' + b.errors.join(' | '));
});

test('vcf: پارسر vCard هر سه نسخه و نام فارسی QUOTED-PRINTABLE را درست می‌خواند', async () => {
    const [a] = await twoLoggedIn('brz-vcf1', ['parser']);
    const parse = a.win.parseVCF;

    /* ۱) خروجی واقعی اندروید: vCard 2.1 با نام فارسیِ QP و soft break */
    const android = [
        'BEGIN:VCARD',
        'VERSION:2.1',
        'N:;,,,',
        /* «سارا خانم مهربان» — فاصلهٔ وسط نام با =20 کد شده و «=» آخر soft break است */
        'FN;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:=D8=B3=D8=A7=D8=B1=D8=A7=20=D8=AE=D8=A7=D9=86=D9=85=20=',
        ' =D9=85=D9=87=D8=B1=D8=A8=D8=A7=D9=86',
        'TEL;CELL:+989121234567',
        'TEL;HOME:021-88776655',
        'END:VCARD'
    ].join('\r\n');
    const c1 = parse(android);
    assert.equal(c1.length, 1);
    /* اگر soft break درست باز نشود، وسط نام یک «=» اضافه می‌ماند */
    assert.equal(c1[0].name, 'سارا خانم مهربان', 'نام QP با soft break درست باز نشد');
    assert.equal(c1[0].name.indexOf('='), -1, 'soft break جا مانده');
    assert.equal(c1[0].tels.join('|'), '+989121234567|021-88776655', 'هر دو شماره باید خوانده شوند');

    /* ۲) QP تک‌خطی */
    const oneLine = 'BEGIN:VCARD\r\nVERSION:2.1\r\nFN;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:' +
        '=D8=B9=D9=84=DB=8C=20=D8=B1=D8=B6=D8=A7=DB=8C=DB=8C\r\nTEL;CELL:09121110000\r\nEND:VCARD';
    assert.equal(parse(oneLine)[0].name, 'علی رضایی');

    /* ۳) vCard 3.0: FN، folding معمولی، escape، و چند TEL با TYPE= */
    const v3 = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        /* دو فاصله: اولی نشانگر fold است و حذف می‌شود، دومی بخشی از مقدار است */
        'FN:Dr. Maryam;',
        '  Karimi',
        'N:Karimi;Maryam;;;Dr.',
        'TEL;TYPE=CELL,VOICE:+98 912 000 1122',
        'TEL;TYPE=WORK:+982112345678',
        'NOTE:line1\\nline2 \\, with comma',
        'END:VCARD'
    ].join('\n');
    const c3 = parse(v3)[0];
    assert.equal(c3.name, 'Dr. Maryam; Karimi', 'folding باید فقط یک فاصله را حذف کند');
    assert.equal(c3.tels.join('|'), '+98 912 000 1122|+982112345678');

    /* ۴) vCard 4.0 با VALUE=uri و پیشوند tel: */
    const v4 = 'BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Reza\r\nTEL;TYPE=cell;VALUE=uri:tel:+989351110000\r\nEND:VCARD';
    assert.equal(parse(v4)[0].tels.join('|'), '+989351110000', 'پیشوند tel: باید حذف شود');

    /* ۵) بدون FN → نام از N ساخته می‌شود (اول نام، بعد نام‌خانوادگی) */
    const noFn = 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:رضایی;علی;;;\r\nTEL:09122223344\r\nEND:VCARD';
    assert.equal(parse(noFn)[0].name, 'علی رضایی');

    /* ۶) کارت بدون شماره به درد همسان‌سازی نمی‌خورد → حذف */
    const noTel = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:بی‌شماره\r\nEMAIL:a@b.c\r\nEND:VCARD';
    assert.equal(parse(noTel).length, 0);

    /* ۷) PHOTO با base64 بزرگ نباید پارسر را بشکند یا به‌عنوان مقدار خوانده شود */
    const big = 'A'.repeat(4000);
    const withPhoto = `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Neda\r\nPHOTO;ENCODING=b;TYPE=JPEG:${big}\r\nTEL:09123334455\r\nEND:VCARD`;
    const c7 = parse(withPhoto);
    assert.equal(c7.length, 1);
    assert.equal(c7[0].name, 'Neda');
    assert.equal(c7[0].tels.join('|'), '09123334455');

    /* ۸) چند کارت پشت هم + خطوط خالی + ORG به‌عنوان نامِ پشتیبان */
    const multi = 'BEGIN:VCARD\nVERSION:3.0\nFN:One\nTEL:09111111111\nEND:VCARD\n\n' +
                  'BEGIN:VCARD\nVERSION:3.0\nORG:شرکت نمونه\nTEL:09222222222\nEND:VCARD';
    const c8 = parse(multi);
    assert.equal(c8.length, 2);
    assert.equal(c8[1].name, 'شرکت نمونه', 'ORG باید جای خالی FN را پر کند');

    /* ۹) ورودی پوچ نباید بیندازد */
    assert.equal(parse('').length, 0);
    assert.equal(parse('BEGIN:VCARD\nEND:VCARD').length, 0);

    assert.deepEqual(a.errors, [], 'خطا: ' + a.errors.join(' | '));
});

test('vcf: واردکردن فایل، نام دفترچهٔ تلفن را نگه می‌دارد و در فهرست نشان می‌دهد', async () => {
    const [a, b] = await twoLoggedIn('brz-vcf2', ['importer', 'target']);
    const tid = await userId(b, 'target');

    /* تارگت شماره‌اش را ثبت می‌کند تا پیدا شدنی باشد */
    const setRes = await (await b.win.fetch('/set_phone', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '09121234567' })
    })).json();
    assert.equal(setRes.success, true, JSON.stringify(setRes));

    /* منتظر می‌مانیم هشِ retained به کاربر اول برسد */
    await waitFor(async () => {
        const r = await (await a.win.fetch('/contacts_lookup', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hashes: ['09121234567'] })
        })).json();
        return r.matches.length === 1;
    }, 15000, 'رسیدن هش شماره به واردکننده');

    /* فایل vcf با نامی که خودِ کاربر در گوشی‌اش گذاشته، نه نام پلتفرم */
    const vcf = [
        'BEGIN:VCARD', 'VERSION:2.1',
        'FN;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:=D8=B3=D8=A7=D8=B1=D8=A7=20=D8=AE=D8=A7=D9=86=D9=85',
        'TEL;CELL:+989121234567',
        'END:VCARD'
    ].join('\r\n');

    await a.win.importVCF({ files: [{ text: async () => vcf }], value: '' });
    await waitFor(async () => a.win.savedContacts().some(c => String(c.id) === String(tid)), 15000, 'ثبت مخاطب واردشده');

    const saved = a.win.savedContacts().find(c => String(c.id) === String(tid));
    assert.equal(saved.local_name, 'سارا خانم', 'نام دفترچهٔ تلفن باید نگه داشته شود');
    assert.equal(saved.username, 'target');

    assert.equal(a.win.localNameFor(tid), 'سارا خانم');

    /* در نتیجهٔ مقایسه هم نامِ دفترچه اولویت دارد */
    const html = a.win.document.getElementById('contactsResult').innerHTML;
    assert.ok(html.indexOf('سارا خانم') >= 0, 'نام دفترچه در نتیجه دیده نمی‌شود');

    /* فهرست چت‌ها هم نام دفترچه را نشان می‌دهد */
    a.win.document.getElementById('userSearch').value = '';
    a.win.renderSideList();
    const row = [...a.win.document.querySelectorAll('#usersList .ui-name')].map(e => e.textContent);
    assert.ok(row.indexOf('سارا خانم') >= 0, 'فهرست چت باید نام دفترچه را نشان دهد: ' + JSON.stringify(row));

    /* جست‌وجو با نام دفترچه هم کار کند */
    a.win.document.getElementById('userSearch').value = 'سارا';
    a.win.renderSideList();
    assert.equal(a.win.document.querySelectorAll('#usersList .user-item').length, 1, 'جست‌وجو با نام دفترچه');

    /* پاک‌کردن */
    a.win.document.getElementById('userSearch').value = '';
    a.win.clearImportedContacts();
    assert.equal(a.win.savedContacts().length, 0);
    assert.equal(a.win.localNameFor(tid), '');

    /* شمارهٔ خام هرگز روی شبکه نرفته باشد */
    for (const t of a.win.JVL.state.topics()) {
        assert.ok(!/9121234567/.test(t), 'شمارهٔ خام روی MQTT رفت: ' + t);
    }

    assert.deepEqual(a.errors, [], 'خطا: ' + a.errors.join(' | '));
    assert.deepEqual(b.errors, [], 'خطا: ' + b.errors.join(' | '));
});

test('PWA: مانیفست و service worker معتبر هستند', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
    assert.equal(manifest.dir, 'rtl');
    assert.equal(manifest.lang, 'fa');
    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.icons.length >= 2);
    for (const ic of manifest.icons) {
        const f = path.join(ROOT, ic.src.replace('./', ''));
        assert.ok(fs.existsSync(f), 'آیکون وجود ندارد: ' + ic.src);
    }
    new (require('node:vm').Script)(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'));
    assert.match(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), /rel="manifest"/);
});
