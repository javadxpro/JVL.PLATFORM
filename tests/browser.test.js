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
    win.__trace = m => { try { require('node:fs').appendFileSync('/tmp/ctrace.log', m + '\n'); } catch { /* ignore */ } };
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
