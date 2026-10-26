'use strict';

/**
 * Web Push — اعلان واقعی روی گوشی وقتی مرورگر/اپ کاملاً بسته است.
 *
 * چرا این بخش به سرور نیاز دارد؟ مرورگر اجازه ندارد مستقیم به سرویس پوش
 * (FCM / Apple / Mozilla) درخواست بزند: هدرهای Authorization و TTL درخواست
 * را «غیرساده» می‌کنند و CORS جلویش را می‌گیرد. پس فرستندهٔ پوش حتماً باید
 * یک سرویس HTTPS باشد.
 *
 * در حالت MQTT/Pages این ماژول بار نمی‌شود و اعلان فقط وقتی اپ باز یا در
 * پس‌زمینه است کار می‌کند (که خودش بدون سرور انجام می‌شود).
 *
 * کلیدهای VAPID یک‌بار ساخته و در data/vapid.json نگه داشته می‌شوند؛ اگر
 * عوض شوند همهٔ اشتراک‌های قبلی باطل می‌شوند.
 */

const fs = require('node:fs');
const path = require('node:path');
const webpush = require('web-push');
const Config = require('./config');

const VAPID_FILE = path.join(Config.dataDir, 'vapid.json');
const SUBJECT = process.env.JVL_VAPID_SUBJECT || 'mailto:admin@localhost';

let vapid = null;

function loadVapid() {
    if (vapid) return vapid;
    if (process.env.JVL_VAPID_PUBLIC && process.env.JVL_VAPID_PRIVATE) {
        vapid = {
            publicKey: process.env.JVL_VAPID_PUBLIC,
            privateKey: process.env.JVL_VAPID_PRIVATE
        };
    } else {
        try {
            if (fs.existsSync(VAPID_FILE)) {
                const raw = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
                if (raw && raw.publicKey && raw.privateKey) vapid = raw;
            }
        } catch { /* خراب بود، از نو می‌سازیم */ }
        if (!vapid) {
            vapid = webpush.generateVAPIDKeys();
            try {
                fs.mkdirSync(Config.dataDir, { recursive: true });
                fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid, null, 2), { mode: 0o600 });
            } catch { /* اگر نشد ذخیره کرد، همین نشست کار می‌کند */ }
        }
    }
    webpush.setVapidDetails(SUBJECT, vapid.publicKey, vapid.privateKey);
    return vapid;
}

function publicKey() {
    return loadVapid().publicKey;
}

/* ───────── اشتراک‌ها ───────── */

function saveSubscription(db, userId, sub) {
    if (!sub || !sub.endpoint || !sub.p256dh || !sub.auth) {
        return { ok: false, message: 'اشتراک معتبر نیست' };
    }
    /* همان endpoint فقط یک ردیف دارد؛ اگر کاربر عوض شد جابه‌جا می‌شود */
    db.run(
        `INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(endpoint) DO UPDATE SET
            user_id = excluded.user_id,
            p256dh  = excluded.p256dh,
            auth    = excluded.auth`,
        sub.endpoint, userId, sub.p256dh, sub.auth,
        new Date().toISOString()
    );
    return { ok: true };
}

function removeSubscription(db, endpoint) {
    if (!endpoint) return 0;
    const info = db.run('DELETE FROM push_subs WHERE endpoint = ?', endpoint);
    return info.changes || 0;
}

function subscriptionsOf(db, userId) {
    return db.all('SELECT * FROM push_subs WHERE user_id = ?', userId);
}

/* ───────── ارسال ───────── */

/**
 * اعلان را به همهٔ دستگاه‌های ثبت‌شدهٔ یک کاربر می‌فرستد.
 * اشتراک‌های مرده (۴۰۴/۴۱۰) همان‌جا پاک می‌شوند تا انبار نشوند.
 *
 * هرگز نباید جریان درخواست را معطل یا خراب کند: اگر سرویس پوش در دسترس
 * نبود، پیام همچنان از راه سوکت/MQTT می‌رسد.
 */
async function pushTo(db, userId, payload) {
    if (!userId) return { sent: 0 };
    let subs;
    try { subs = subscriptionsOf(db, userId); } catch { return { sent: 0 }; }
    if (!subs.length) return { sent: 0 };

    loadVapid();
    const body = JSON.stringify(payload || {});
    let sent = 0;
    for (const row of subs) {
        try {
            await webpush.sendNotification(
                { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
                body,
                { TTL: 60, urgency: 'high', topic: String(payload && payload.tag || 'jvl') }
            );
            sent++;
        } catch (e) {
            const status = e && e.statusCode;
            /* ۴۰۴/۴۱۰ یعنی اشتراک باطل شده؛ ۴۲۹ یعنی موقتاً شلوغ است */
            if (status === 404 || status === 410) {
                try { removeSubscription(db, row.endpoint); } catch { /* ignore */ }
            }
        }
    }
    return { sent };
}

module.exports = { publicKey, saveSubscription, removeSubscription, subscriptionsOf, pushTo };
