'use strict';

/**
 * مسیرهای عمومی: اطلاعات برنامه، فایل‌های آپلودشده، دارایی‌های استاتیک
 * (socket.io کلاینت + فونت وزیرمتن از node_modules) و خود index.html.
 */

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const Config = require('../config');

const router = express.Router();

/* ───────── دارایی‌های استاتیک از node_modules ───────── */

function resolveFrom(packageName, subPath) {
    try {
        const pkgJson = require.resolve(`${packageName}/package.json`, { paths: [Config.root] });
        const p = path.join(path.dirname(pkgJson), subPath);
        return fs.existsSync(p) ? p : null;
    } catch {
        return null;
    }
}

const SOCKET_IO_CLIENT = resolveFrom('socket.io-client', 'dist/socket.io.min.js')
    || path.join(Config.root, 'public', 'static', 'js', 'socket.io.min.js');
const FONTS_DIR = resolveFrom('vazirmatn', 'fonts/webfonts')
    || path.join(Config.root, 'public', 'static', 'fonts');

router.get('/api/app_info', (req, res) => {
    res.json({
        name: Config.app_name,
        version: Config.app_version,
        node: process.version,
        limits: { image: Config.limits.image, video: Config.limits.video, file: Config.limits.file },
        story_ttl_hours: Config.storyTtlHours,
        urls: Config.lanUrls()
    });
});

/* کلاینت این دو مسیر را دقیقاً به همین شکل صدا می‌زند */
router.get('/static/js/socket.io.min.js', (req, res) => {
    if (!fs.existsSync(SOCKET_IO_CLIENT)) {
        return res.status(404).type('text/plain; charset=utf-8')
            .send('socket.io client not found — run: npm install');
    }
    res.type('application/javascript').set('Cache-Control', 'public, max-age=86400').sendFile(SOCKET_IO_CLIENT);
});

router.get('/static/fonts/:file', (req, res) => {
    const file = path.basename(req.params.file);
    if (!/^[A-Za-z0-9[\]()._-]+\.woff2?$/.test(file)) return res.status(400).end();
    const p = path.join(FONTS_DIR, file);
    if (!fs.existsSync(p)) return res.status(404).end();
    res.type(file.endsWith('.woff2') ? 'font/woff2' : 'font/woff')
        .set('Cache-Control', 'public, max-age=604800')
        .sendFile(p);
});

/* پوشهٔ static ریشه: همان دارایی‌هایی که GitHub Pages هم سرو می‌کند
   (mqtt.min.js، لایهٔ MQTT و فونت‌ها) — یک نسخه برای هر دو حالت */
const staticDir = path.join(Config.root, 'static');
if (fs.existsSync(staticDir)) router.use('/static', express.static(staticDir, { index: false }));

/* ───────── فایل‌های آپلودشده ───────── */

/**
 * /files/<kind>/<name> — kind فقط از فهرست مجاز، name فقط basename.
 * بدون توکن (چون در <img>/<video> استفاده می‌شود)، با پشتیبانی Range برای ویدیو.
 */
router.get('/files/:kind/:name', (req, res) => {
    const kind = req.params.kind;
    if (!Config.uploadKinds.includes(kind)) return res.status(404).end();
    const name = path.basename(req.params.name);
    if (!name || name.startsWith('.')) return res.status(404).end();
    const dir = Config.uploads[kind];
    const file = path.join(dir, name);
    /* دفاع در برابر مسیرسازی: نتیجه باید داخل پوشهٔ دسته باشد */
    if (!file.startsWith(dir + path.sep)) return res.status(404).end();
    if (!fs.existsSync(file)) return res.status(404).end();
    res.sendFile(file);
});

/* ───────── صفحهٔ اصلی ───────── */

router.get('/', (req, res) => {
    res.sendFile(Config.indexHtml);
});

module.exports = router;
module.exports.SOCKET_IO_CLIENT = SOCKET_IO_CLIENT;
module.exports.FONTS_DIR = FONTS_DIR;
