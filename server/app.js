'use strict';

/**
 * ساخت برنامهٔ Express.
 * createApp() بدون سرور HTTP برمی‌گرداند تا در تست‌ها مستقیم استفاده شود.
 */

const express = require('express');
const fs = require('node:fs');
const Config = require('./config');
const { setDb, getDb } = require('./db');

const metaRoutes = require('./routes/meta');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const chatRoutes = require('./routes/chat');
const groupRoutes = require('./routes/groups');
const socialRoutes = require('./routes/social');
const lanRoutes = require('./routes/lan');
const channelRoutes = require('./routes/channels');
const pushRoutes = require('./routes/push');
const profileRoutes = require('./routes/profile');
const adminRoutes = require('./routes/admin');

function createApp(options = {}) {
    if (options.db) setDb(options.db);
    getDb(); /* اتصال/مایگریت زودهنگام */

    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: false, limit: '1mb' }));

    /* لاگ کوتاه درخواست‌ها (قابل خاموش‌کردن با JVL_QUIET=1) */
    if (!process.env.JVL_QUIET) {
        app.use((req, res, next) => {
            res.on('finish', () => {
                if (res.statusCode >= 400 || !req.path.startsWith('/files/')) {
                    console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} → ${res.statusCode}`);
                }
            });
            next();
        });
    }

    /* عمومی */
    app.use(metaRoutes);
    app.use(authRoutes);

    /* نیازمند توکن */
    app.use(userRoutes);
    app.use(chatRoutes);
    app.use(groupRoutes);
    app.use(socialRoutes);
    app.use(lanRoutes);
    app.use(channelRoutes);
    app.use(pushRoutes);
    app.use(profileRoutes);
    app.use('/api/admin', adminRoutes);

    /* سلامت سرویس */
    app.get('/api/health', (req, res) => res.json({ ok: true, version: Config.app_version }));

    /* هر GET ناشناخته → صفحهٔ اصلی (کلاینت تک‌صفحه‌ای است) */
    app.get(/^\/(?!api\/).*/, (req, res, next) => {
        if (!fs.existsSync(Config.indexHtml)) return next();
        res.sendFile(Config.indexHtml);
    });

    /* ۴۰۴ برای API */
    app.use((req, res) => {
        res.status(404).json({ success: false, message: 'مسیر پیدا نشد', path: req.originalUrl });
    });

    /* خطاهای پیش‌بینی‌نشده */
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        console.error('❌', req.method, req.originalUrl, err && err.stack ? err.stack : err);
        if (res.headersSent) return;
        res.status(500).json({ success: false, message: 'خطای داخلی سرور' });
    });

    app.locals.config = Config;
    return app;
}

module.exports = { createApp };
