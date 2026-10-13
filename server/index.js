'use strict';

/**
 * نقطهٔ شروع سرور: HTTP + Socket.IO روی یک پورت.
 * اجرای مستقیم: node server/index.js   (یا: npm start / node server/cli.js start)
 */

const http = require('node:http');
const Config = require('./config');
const { createApp } = require('./app');
const rt = require('./realtime');
const { pruneStories } = require('./services');

function startServer(options = {}) {
    const app = createApp(options);
    const server = http.createServer(app);
    rt.attach(server);

    /* پاک‌سازی استوری‌های منقضی: هر ساعت و هنگام شروع */
    try { pruneStories(); } catch (e) { console.warn('pruneStories:', e.message); }
    const pruner = setInterval(() => {
        try {
            const n = pruneStories();
            if (n) console.log(`🧹 ${n} استوری منقضی پاک شد`);
        } catch (e) { console.warn('pruneStories:', e.message); }
    }, 60 * 60 * 1000);
    pruner.unref();

    /* پورت ۰ یعنی «پورت آزاد» — پس نباید با || به Config.port برگردد */
    const port = options.port === undefined ? Config.port : Number(options.port);
    const host = options.host || Config.host;
    /* تا آدرس‌های چاپ‌شده در لاگ با پورت واقعی یکی باشند */
    Config.port = port;
    Config.host = host;

    server.listen(port, host, () => {
        console.log(`\n  ${Config.app_name} v${Config.app_version} — سرور شبکهٔ محلی`);
        console.log('  در دسترس روی:');
        for (const url of Config.lanUrls()) console.log(`    • ${url}`);
        console.log(`  داده‌ها: ${Config.dbFile}`);
        console.log(`  آپلودها: ${Config.uploads.root}\n`);
    });

    const shutdown = () => {
        clearInterval(pruner);
        rt.reset();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1500).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    return { app, server };
}

module.exports = { startServer };

if (require.main === module) {
    startServer();
}
