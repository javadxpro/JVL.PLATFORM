'use strict';

/**
 * بن‌کردن بر پایهٔ IP.
 *
 * دو نکتهٔ امنیتی که عمدی این‌طور نوشته شده‌اند:
 *
 * ۱) به‌صورت پیش‌فرض IP از خودِ سوکت گرفته می‌شود، نه از X-Forwarded-For.
 *    اگر کورکورانه به آن هدر اعتماد کنیم، کاربرِ بن‌شده کافی است یک هدر
 *    دلخواه بفرستد و بن را دور بزند. فقط وقتی JVL_TRUST_PROXY روشن باشد
 *    (یعنی واقعاً پشت ریورس‌پروکسی هستی) اولین هاپ خوانده می‌شود.
 *
 * ۲) از CIDR هم پشتیبانی می‌شود، چون روی موبایل و بیشتر ISPهای ایران IP
 *    با هر اتصال عوض می‌شود و بنِ تک‌IP عملاً بی‌اثر است.
 */

const net = require('node:net');

/** آیا به هدرهای پروکسی اعتماد کنیم؟ پیش‌فرض: نه */
function trustProxy() {
    const v = String(process.env.JVL_TRUST_PROXY || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** «::ffff:1.2.3.4» → «1.2.3.4» تا یک IP دو جور ذخیره/مقایسه نشود */
function normalizeIp(ip) {
    let s = String(ip || '').trim();
    if (!s) return '';
    /* آدرس لینک‌لوکال IPv6 همیشه همان لوکال‌هاست */
    if (s === '::1') return '127.0.0.1';
    const m = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (m) return m[1];
    return s;
}

/** IP کلاینت؛ اگر پشت پروکسی باشیم اولین هاپِ X-Forwarded-For */
function clientIp(req) {
    if (!req) return '';
    if (trustProxy()) {
        const xff = req.headers && (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For']);
        if (xff) {
            const first = String(xff).split(',')[0].trim();
            if (net.isIP(first)) return normalizeIp(first);
        }
        const real = req.headers && req.headers['x-real-ip'];
        if (real && net.isIP(String(real))) return normalizeIp(real);
    }
    const sock = req.socket || req.connection || {};
    return normalizeIp(sock.remoteAddress || '');
}

/** «192.168.1.0/24» را باز می‌کند؛ اگر CIDR نبود null */
function parseCidr(entry) {
    const parts = String(entry).split('/');
    if (parts.length !== 2) return null;
    const bits = Number(parts[1]);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    if (net.isIP(parts[0]) !== 4) return null;   /* CIDR فقط برای IPv4 */
    return { base: ipToInt(parts[0]), mask: bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0 };
}

function ipToInt(ip) {
    return ip.split('.').reduce((acc, o) => ((acc << 8) + Number(o)) >>> 0, 0) >>> 0;
}

/** آیا ip داخل این قاعده (IP خام یا CIDR) می‌افتد؟ */
function ipMatches(entry, ip) {
    const e = normalizeIp(entry), target = normalizeIp(ip);
    if (!e || !target) return false;
    if (e.indexOf('/') < 0) return e === target;
    const cidr = parseCidr(e);
    if (!cidr) return false;
    if (net.isIP(target) !== 4) return false;
    return ((ipToInt(target) & cidr.mask) >>> 0) === ((cidr.base & cidr.mask) >>> 0);
}

/**
 * شبکهٔ شامل یک IP را می‌سازد: «91.98.7.211» با ۲۴ → «91.98.7.0/24».
 * برای وقتی لازم است که IP کاربر با هر اتصال عوض می‌شود و بنِ تک‌IP
 * عملاً بی‌اثر است. فقط IPv4.
 */
function cidrOf(ip, bits) {
    const value = normalizeIp(ip);
    if (net.isIP(value) !== 4) return null;
    const b = Number(bits);
    if (!Number.isInteger(b) || b < 8 || b > 32) return null;
    const mask = b === 0 ? 0 : (0xFFFFFFFF << (32 - b)) >>> 0;
    const base = (ipToInt(value) & mask) >>> 0;
    const octets = [(base >>> 24) & 255, (base >>> 16) & 255, (base >>> 8) & 255, base & 255];
    return octets.join('.') + '/' + b;
}

/* ───────── عملیات روی دیتابیس ───────── */

function bannedIps(db) {
    return db.all('SELECT * FROM banned_ips ORDER BY id DESC');
}

function isIpBanned(db, ip) {
    const target = normalizeIp(ip);
    if (!target) return null;
    for (const row of bannedIps(db)) {
        if (ipMatches(row.ip, target)) return row;
    }
    return null;
}

function banIp(db, ip, byUserId, reason) {
    const value = normalizeIp(ip);
    if (!value) return { ok: false, message: 'IP خالی است' };
    if (value.indexOf('/') < 0 && !net.isIP(value)) return { ok: false, message: 'IP معتبر نیست' };
    if (value.indexOf('/') >= 0 && !parseCidr(value)) return { ok: false, message: 'CIDR معتبر نیست' };
    /* بن‌کردن لوکال‌هاست یعنی قفل‌کردن درِ سرور به روی خودت */
    if (value === '127.0.0.1' || value === '::1') {
        return { ok: false, message: 'نمی‌شود لوکال‌هاست را بن کرد (خودت را بیرون می‌اندازی)' };
    }
    db.run(
        `INSERT INTO banned_ips (ip, reason, banned_by, created_at) VALUES (?,?,?,?)
         ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by`,
        value, String(reason || '').slice(0, 200), byUserId || null,
        new Date().toISOString().replace('T', ' ').slice(0, 19)
    );
    return { ok: true, ip: value };
}

function unbanIp(db, ip) {
    const value = normalizeIp(ip);
    if (!value) return 0;
    return db.run('DELETE FROM banned_ips WHERE ip = ?', value).changes;
}

/** آخرین IP ثبت‌شدهٔ کاربر؛ برای بن‌کردن همان لحظه لازم است */
function rememberIp(db, userId, ip) {
    const value = normalizeIp(ip);
    if (!userId || !value) return;
    try { db.run('UPDATE users SET last_ip = ? WHERE id = ?', value, userId); } catch { /* ignore */ }
}

module.exports = {
    trustProxy,
    cidrOf,
    normalizeIp,
    clientIp,
    parseCidr,
    ipMatches,
    bannedIps,
    isIpBanned,
    banIp,
    unbanIp,
    rememberIp
};
