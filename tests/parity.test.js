'use strict';

/**
 * تستِ هم‌ارزیِ دو لایه.
 *
 * این پروژه یک API دارد با دو پیاده‌سازی: سرور نود (`server/`) و «سرور مجازی»
 * داخل مرورگر (`static/js/mqtt-backend.js`). قاعدهٔ صریحِ پروژه این است که دو
 * حالت واگرا نمانند — ولی هیچ تستی این را نمی‌سنجید. نتیجه‌اش شد که سه مسیرِ
 * همسان‌سازی مخاطبین فقط در شیم پیاده شده بود و در حالت REST با ۴۰۴ می‌مرد، و
 * `post_deleted` سال‌ها منتشر می‌شد بدون اینکه کلاینت گوش دهد.
 *
 * این فایل کد را اجرا نمی‌کند؛ منبع را می‌خواند و سه چیز را چک می‌کند:
 *   ۱) هر مسیرِ شیم در سرور هم باشد، و مسیرهای فقط‌سرور همان استثناهای مستند باشند
 *   ۲) هر رویدادی که کلاینت `socket.on` می‌کند کسی بفرستد، و هر رویدادی که
 *      فرستاده می‌شود کلاینت گوش دهد
 *   ۳) هر `getElementById` به `id`‌ای که واقعاً در HTML هست اشاره کند
 *
 * اگر روزی مسیر یا رویدادی اضافه کردی و این تست شکست، یعنی یک لایه جا مانده.
 * استثنا باید اینجا با دلیل نوشته شود، نه با پاک‌کردنِ چک.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const norm = p => p.replace(/:[A-Za-z_]+/g, ':X');

/**
 * مسیرهای سرور با پیشوندِ mount‌شان. روترها بدون پیشوند mount می‌شوند به‌جز
 * ادمین که زیر `/api/admin` است — بدون این نگاشت، مسیرهای ادمین همیشه
 * «گم‌شده» به نظر می‌رسیدند.
 */
function serverRoutes() {
    const app = read('server/app.js');
    const mods = {};
    for (const m of app.matchAll(/const (\w+) = require\('\.\/routes\/([\w-]+)'\)/g)) mods[m[1]] = m[2];

    const out = new Set();
    for (const m of app.matchAll(/app\.use\((?:'([^']*)',\s*)?(\w+)\)/g)) {
        const mod = mods[m[2]];
        if (!mod) continue;
        const prefix = (m[1] || '').replace(/\/$/, '');
        for (const r of read(`server/routes/${mod}.js`).matchAll(/router\.(get|post|put|delete|patch)\(\s*'([^']+)'/g)) {
            out.add(`${r[1].toUpperCase()} ${norm(prefix + r[2])}`);
        }
    }
    for (const r of app.matchAll(/app\.(get|post|put|delete|patch)\(\s*'([^']+)'/g)) {
        out.add(`${r[1].toUpperCase()} ${norm(r[2])}`);
    }
    return out;
}

function shimRoutes() {
    const src = read('static/js/mqtt-backend.js');
    return new Set([...src.matchAll(/route\(\s*'([A-Z]+)'\s*,\s*'([^']+)'/g)].map(m => `${m[1]} ${norm(m[2])}`));
}

/**
 * چیزهایی که ذاتاً فقط سمت سرور معنا دارند. هر کدام دلیل دارد؛ افزودنِ مورد
 * تازه یعنی پذیرفتنِ یک واگراییِ تازه.
 */
const SERVER_ONLY = new Set([
    'GET /',                              /* صفحهٔ اصلی — روی Pages خودِ میزبان می‌دهدش */
    'GET /files/:X/:X',                   /* فایل آپلودشده روی دیسک سرور */
    'GET /static/fonts/:X',               /* دارایی استاتیک */
    'GET /static/js/socket.io.min.js',    /* دارایی استاتیک */
    'GET /push_public_key',               /* Web Push به کلید VAPID سمت سرور نیاز دارد */
    'POST /push_subscribe',               /* همین */
    'POST /push_unsubscribe',             /* همین */
    'POST /api/admin/ban_ip',             /* بنِ نشانی در حالت MQTT ممکن نیست: IP کسی دیده نمی‌شود */
    'DELETE /api/admin/unban_ip/:X',      /* همین */
    'GET /api/admin/banned_ips'           /* همین */
]);

test('هر مسیرِ لایهٔ MQTT در سرور نود هم پیاده شده است', () => {
    const missing = [...shimRoutes()].filter(r => !serverRoutes().has(r)).sort();
    assert.deepEqual(missing, [], 'این مسیرها فقط در شیم هستند و در حالت REST کار نمی‌کنند');
});

test('مسیرهای فقط‌سرور همان استثناهای مستند هستند', () => {
    const serverOnly = [...serverRoutes()].filter(r => !shimRoutes().has(r)).sort();

    const undocumented = serverOnly.filter(r => !SERVER_ONLY.has(r));
    assert.deepEqual(undocumented, [],
        'مسیر تازه‌ای فقط سمت سرور اضافه شده؛ یا در شیم هم پیاده‌اش کن یا با دلیل به SERVER_ONLY اضافه کن');

    const gone = [...SERVER_ONLY].filter(r => !serverOnly.includes(r));
    assert.deepEqual(gone, [],
        'این استثناها دیگر وجود ندارند؛ از SERVER_ONLY پاکشان کن تا فهرست کهنه نماند');
});

/* ───────── مسیرهایی که خودِ کلاینت صدا می‌زند ───────── */

/**
 * هر مسیری که index.html با apiFetch می‌خواند. هم شکلِ کامل
 * (`apiFetch('/users'`) و هم پیشوندها (`apiFetch('/group_join/' + gid)` و
 * قالب‌های `${}`) گرفته می‌شوند؛ فراخوانی با متغیرِ مسیر قابلِ دیدن نیست و
 * رد می‌شود.
 */
function clientPaths() {
    const html = read('index.html');
    const exact = new Set();
    const prefix = new Set();
    for (const m of html.matchAll(/apiFetch\(\s*'([^']+)'\s*(\+|,|\))/g)) {
        (m[2] === '+' ? prefix : exact).add(m[1]);
    }
    for (const m of html.matchAll(/apiFetch\(\s*`([^`$]+)\$/g)) prefix.add(m[1]);
    return { exact, prefix };
}

/** مجموعهٔ «METHOD /path» را به مجموعهٔ «/path» تبدیل می‌کند */
const pathsOnly = set => [...set].map(r => r.replace(/^[A-Z]+ /, ''));

/**
 * مسیرِ کامل باید **دقیقاً** وجود داشته باشد؛ پیشوند (جایی که کلاینت شناسه را
 * با `+` یا `${}` می‌چسباند) با startsWith سنجیده می‌شود. تطابقِ شل برای مسیرِ
 * کامل خطرناک است: `/set_phone_DISABLED` هم با `/set_phone` مطابقت می‌کرد و
 * تست، همان باگی را که برای گرفتنش نوشته شده بود، رد می‌کرد.
 */
function covered(p, routes, isPrefix) {
    /* پیشوندی که query string می‌چسباند (`'/public_groups' + '?q=…'`) مسیرِ کامل است */
    if (!isPrefix || !p.endsWith('/')) return routes.includes(p);
    /* `/group_join/` → `/group_join/:X`؛ و `/user_profile/` → `/user_profile/:X/:X` */
    return routes.some(r => r === `${p}:X` || r.startsWith(`${p}:X/`));
}

test('هر مسیری که کلاینت صدا می‌زند در سرور نود هست', () => {
    const { exact, prefix } = clientPaths();

    const routes = pathsOnly(serverRoutes());
    const gone = [];
    for (const x of exact) if (!covered(norm(x), routes, false)) gone.push(norm(x));
    for (const x of prefix) if (!covered(norm(x), routes, true)) gone.push(norm(x) + '…');
    assert.deepEqual(gone.sort(), [],
        'کلاینت مسیری را صدا می‌زند که سرور ندارد — در حالت REST با ۴۰۴ می‌میرد (همان باگی که /set_phone داشت)');
});

test('مسیرهای کلاینت در حالت MQTT هم کار می‌کنند، مگر استثناهای مستند', () => {
    const { exact, prefix } = clientPaths();
    const shim = pathsOnly(shimRoutes());
    const allowed = pathsOnly(SERVER_ONLY);

    /*
     * بنِ نشانی و Web Push ذاتاً به سرور نیاز دارند، پس در حالت MQTT جواب
     * نمی‌دهند و رابط هم صادقانه همین را می‌گوید. هر موردِ تازه یعنی یک
     * قابلیت که بی‌خبر در حالت Pages کار نمی‌کند.
     */
    const unexplained = [];
    const ok = (p, isPrefix) => {
        if (covered(p, shim, isPrefix)) return true;
        /* جزو استثناهای مستند است؟ */
        return allowed.some(a => a === p || (isPrefix && a.startsWith(p)));
    };
    for (const x of exact) if (!ok(norm(x), false)) unexplained.push(norm(x));
    for (const x of prefix) if (!ok(norm(x), true)) unexplained.push(norm(x) + '…');
    assert.deepEqual(unexplained.sort(), [],
        'این مسیرها در لایهٔ MQTT نیستند و جزو استثناهای مستند هم نیستند');
});

/* ───────── رویدادهای Socket.IO ───────── */

/** نام‌های لیترالی که به یک تابعِ انتشار داده شده‌اند */
function emitted(src) {
    const names = new Set();
    const re = /(?:emitTo|broadcast|broadcastUserStatus|relayCall|socketEmit)\(\s*'([^']+)'/g;
    for (const m of src.matchAll(re)) names.add(m[1]);
    return names;
}

function allEmitted() {
    const server = read('server/realtime.js') + fs.readdirSync(path.join(ROOT, 'server/routes'))
        .map(f => read(`server/routes/${f}`)).join('\n');
    const names = emitted(server);
    for (const n of emitted(read('static/js/mqtt-backend.js'))) names.add(n);
    return names;
}

function clientListens() {
    const names = new Set();
    for (const m of read('index.html').matchAll(/socket\.on\(\s*'([^']+)'/g)) names.add(m[1]);
    return names;
}

/** رویدادهای خودِ socket.io که هیچ‌کس صریحاً نمی‌فرستدشان */
const SOCKET_BUILTINS = new Set(['connect', 'disconnect', 'connect_error', 'reconnect', 'error']);

test('کلاینت به رویدادی گوش نمی‌دهد که هیچ‌کس نمی‌فرستد', () => {
    const send = allEmitted();
    /*
     * `socketEmit('call_' + event.t, …)` نام را می‌سازد، پس `call_` به‌تنهایی
     * گرفته می‌شود. چنین پیشوندهایی را نادیده نمی‌گیریم: باید دستِ‌کم یک
     * شنونده با همان پیشوند وجود داشته باشد.
     */
    const orphan = [...clientListens()]
        .filter(n => !SOCKET_BUILTINS.has(n) && !send.has(n) && ![...send].some(p => p.endsWith('_') && n.startsWith(p)))
        .sort();
    assert.deepEqual(orphan, [], 'کلاینت منتظر رویدادی است که هیچ لایه‌ای منتشر نمی‌کند');
});

test('هر رویدادی که منتشر می‌شود شنونده دارد', () => {
    const listen = clientListens();
    const dead = [...allEmitted()]
        .filter(n => !listen.has(n) && !SOCKET_BUILTINS.has(n) && !n.endsWith('_'))
        .sort();
    assert.deepEqual(dead, [],
        'این رویدادها منتشر می‌شوند ولی کلاینت socket.on ندارد — یا هندلر اضافه کن یا انتشار را بردار');
});

/* ───────── شناسه‌های DOM ───────── */

test('هر getElementById به شناسه‌ای که در HTML هست اشاره می‌کند', () => {
    const html = read('index.html');
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
    /* شناسه‌هایی که در زمان اجرا ساخته می‌شوند (div.id = 'msg-' + msg.id) */
    for (const m of html.matchAll(/\.id\s*=\s*'([^']+)'/g)) ids.add(m[1]);

    const missing = [];
    for (const m of html.matchAll(/getElementById\(\s*'([^']+)'\s*(\+|\))/g)) {
        const [, name, tail] = m;
        if (tail === '+') {
            /* `getElementById('ccmts-' + pid)` — باید پیشوندِ دستِ‌کم یک id باشد */
            if (![...ids].some(id => id.startsWith(name))) missing.push(name + '… (پیشوند)');
        } else if (!ids.has(name)) {
            missing.push(name);
        }
    }
    assert.deepEqual([...new Set(missing)].sort(), [],
        'این شناسه‌ها در HTML نیستند — در زمان اجرا null برمی‌گردند و بی‌صدا می‌شکنند');
});
