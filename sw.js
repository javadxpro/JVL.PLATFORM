/*
 * Service Worker — پوستهٔ برنامه را کش می‌کند تا اپ حتی با اینترنت ضعیف
 * یا لحظه‌های قطعی باز شود. داده‌ها هرگز کش نمی‌شوند: همه‌چیز زنده از MQTT
 * می‌آید و «موقتی» می‌ماند.
 */
const CACHE = 'volexturn-shell-v1';
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
