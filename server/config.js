'use strict';

/**
 * پیکربندی مرکزی سرور.
 *
 * app_version باید با ثابت APP_VERSION در index.html یکی باشد.
 * تست آن: tests/cli.test.js (همان نقشی که tests/test_cli.py در نسخهٔ پایتون داشت).
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const MB = 1024 * 1024;
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.JVL_DATA_DIR || path.join(ROOT, 'data');

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/* کلید امضای توکن: یک بار تولید و در دیتادایر ذخیره می‌شود تا با ری‌استارت
   سرور، نشست‌های کاربران باطل نشود. */
function loadOrCreateSecret(file) {
    if (process.env.JVL_SECRET) return process.env.JVL_SECRET;
    try {
        const existing = fs.readFileSync(file, 'utf8').trim();
        if (existing) return existing;
    } catch { /* اولین اجرا */ }
    const secret = crypto.randomBytes(32).toString('hex');
    try {
        fs.writeFileSync(file, secret, { mode: 0o600 });
    } catch { /* فایل‌سیستم فقط‌خواندنی — در حافظه ادامه می‌دهیم */ }
    return secret;
}

const uploadsRoot = ensureDir(path.join(DATA_DIR, 'uploads'));

const Config = {
    /* ← نسخهٔ برنامه؛ با APP_VERSION در index.html همگام است */
    app_version: '4.0.0',
    app_name: 'Volexturn',

    host: process.env.HOST || '0.0.0.0',
    port: Number(process.env.PORT || 3000),

    root: ROOT,
    indexHtml: path.join(ROOT, 'index.html'),
    dataDir: DATA_DIR,
    dbFile: process.env.JVL_DB || path.join(DATA_DIR, 'jvl.db'),

    uploads: {
        root: uploadsRoot,
        chat: ensureDir(path.join(uploadsRoot, 'chat')),
        posts: ensureDir(path.join(uploadsRoot, 'posts')),
        stories: ensureDir(path.join(uploadsRoot, 'stories')),
        profiles: ensureDir(path.join(uploadsRoot, 'profiles'))
    },
    /* کدام زیرپوشه برای کدام نوع آپلود مجاز است (مسیر فایل‌ها از کلاینت می‌آید) */
    uploadKinds: ['chat', 'posts', 'stories', 'profiles'],

    limits: {
        image: 5 * MB,
        video: 10 * MB,
        file: 50 * MB,          /* سقف عمومی هر فایل */
        field: 1 * MB,          /* سقف فیلدهای متنی فرم */
        files: 1
    },

    /* استوری ۲۴ ساعت اعتبار دارد (کلاینت هم همین را نشان می‌دهد) */
    storyTtlHours: 24,

    /* اعتبار توکن ورود: ۳۰ روز */
    tokenTtlSeconds: 30 * 24 * 3600,

    secret: loadOrCreateSecret(path.join(DATA_DIR, 'secret.key')),

    /* اولین کاربر ثبت‌نام‌کرده به‌صورت خودکار مدیر می‌شود */
    firstUserIsAdmin: true
};

/* نام شبکه محلی برای نمایش در لاگ شروع */
Config.lanUrls = function lanUrls() {
    const out = [`http://localhost:${Config.port}`];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const info of ifaces[name] || []) {
            if (info.family === 'IPv4' && !info.internal) out.push(`http://${info.address}:${Config.port}`);
        }
    }
    return out;
};

module.exports = Config;
