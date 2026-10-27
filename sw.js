/*
 * Service Worker — پوستهٔ برنامه را کش می‌کند تا اپ حتی با اینترنت ضعیف
 * یا لحظه‌های قطعی باز شود. داده‌ها هرگز کش نمی‌شوند: همه‌چیز زنده از MQTT
 * می‌آید و «موقتی» می‌ماند.
 */
/*
 * نسخهٔ پوسته. هندلر fetch پایین cache-first است، پس تا وقتی این نام عوض نشود
 * service worker کاربران همان فایل‌های کش‌شده را سرو می‌کند و اصلاحات هرگز به
 * دستشان نمی‌رسد. activate همهٔ کش‌های با نام دیگر را پاک می‌کند.
 */
const CACHE = 'volexturn-shell-v4';
const SHELL = [
    './',
    './index.html',
    './manifest.webmanifest',
    './icon.svg',
    './icon-192.png',
    './icon-512.png',
    './static/js/mqtt.min.js',
    './static/js/mqtt-backend.js',
    './static/fonts/Vazirmatn-Regular.woff2',
    './static/fonts/Vazirmatn-Medium.woff2',
    './static/fonts/Vazirmatn-Bold.woff2',
    './static/fonts/Vazirmatn-Black.woff2'
];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

/* ───────────────────────── اعلان‌ها ─────────────────────────
 *
 * دو مسیر وجود دارد:
 *  ۱) وقتی اپ باز است → خود صفحه با showNotification اعلان می‌دهد (بدون سرور).
 *  ۲) وقتی اپ بسته است → سرویس پوش (FCM/Apple/Mozilla) این هندلر را بیدار
 *     می‌کند. این حالت به یک سرور نیاز دارد، چون مرورگر اجازه ندارد مستقیم
 *     به سرویس پوش POST بزند (CORS جلویش را می‌گیرد).
 *
 * هر دو در همین یک هندلر به اعلان واقعی تبدیل می‌شوند.
 */
self.addEventListener('push', (e) => {
    let data = {};
    if (e.data) {
        try { data = e.data.json(); }
        catch { data = { title: 'Volexturn', body: (e.data.text && e.data.text()) || '' }; }
    }
    const title = data.title || 'Volexturn';
    e.waitUntil(
        self.registration.showNotification(title, {
            body: data.body || '',
            icon: './icon-192.png',
            badge: './icon-192.png',
            dir: 'rtl',
            lang: 'fa',
            tag: data.tag || 'jvl',
            renotify: !!data.tag,
            /* روی گوشی صدا و لرزش؛ دیتا را به کلیک پاس می‌دهیم */
            data: {
                url: data.url || './index.html',
                peer: data.peer || null,
                group: data.group || null,
                call: data.call || null
            }
        })
    );
});

self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    const d = (e.notification.data) || {};
    const target = new URL(d.url || './index.html', self.location.href);
    if (d.peer) target.searchParams.set('peer', d.peer);
    if (d.group) target.searchParams.set('group', d.group);
    if (d.call) target.searchParams.set('call', d.call);

    e.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
            for (const c of list) {
                if ('focus' in c) {
                    /* اگر اپ باز است، همان را بیاور جلو و بگو کجا برود */
                    c.postMessage({ type: 'jvl-navigate', peer: d.peer || null, group: d.group || null });
                    return c.focus();
                }
            }
            return self.clients.openWindow(target.href);
        })
    );
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    /* هرگز درخواست‌های شبکه را کش نکن */
    if (url.pathname.includes('/api/')) return;
    e.respondWith(
        caches.match(req).then(hit => hit || fetch(req).then(res => {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
            return res;
        }).catch(() => caches.match('./index.html')))
    );
});
