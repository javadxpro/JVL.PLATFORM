'use strict';

/**
 * احراز هویت: هش رمز با scrypt و توکن امضاشده (HMAC-SHA256).
 * بدون وابستگی خارجی.
 */

const crypto = require('node:crypto');
const Config = require('./config');
const { getDb, now } = require('./db');
const ban = require('./ban');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* رکورد کامل رمز: "<salt_hex>$scrypt$N$r$p$<key_hex>" — یک فیلد، خودش شامل نمک */
function makePasswordRecord(password) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
    return `${salt.toString('hex')}$scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${key.toString('hex')}`;
}

function checkPassword(password, record) {
    if (typeof record !== 'string' || !record.includes('$')) return false;
    const [saltHex, scheme, N, r, p, keyHex] = record.split('$');
    if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const key = crypto.scryptSync(String(password), salt, Number(keyHex.length / 2),
        { N: Number(N), r: Number(r), p: Number(p) });
    const expected = Buffer.from(keyHex, 'hex');
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

/* ───────── توکن ───────── */

function signToken(userId, ttlSeconds = Config.tokenTtlSeconds) {
    const payload = b64url(JSON.stringify({ sub: Number(userId), exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
    const sig = b64url(crypto.createHmac('sha256', Config.secret).update(payload).digest());
    return `${payload}.${sig}`;
}

function verifyToken(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const [payload, sig] = token.split('.');
    const expected = b64url(crypto.createHmac('sha256', Config.secret).update(payload).digest());
    const a = Buffer.from(sig || '');
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let data;
    try { data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
    catch { return null; }
    if (!data || !data.sub || !data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
}

function bearer(req) {
    const h = req.get('authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    return m ? m[1].trim() : '';
}

/* ───────── میدل‌ورها ───────── */

function publicUser(u) {
    if (!u) return null;
    return {
        id: u.id,
        username: u.username,
        full_name: u.full_name,
        bio: u.bio || '',
        avatar: u.avatar || null,
        role: u.role,
        created_at: u.created_at
    };
}

/** توکن معتبر لازم است؛ کاربر در req.user قرار می‌گیرد (وگرنه 401 → کلاینت لاگ‌اوت می‌کند) */
function requireAuth(req, res, next) {
    const token = bearer(req);
    const data = token ? verifyToken(token) : null;
    if (!data) return res.status(401).json({ success: false, message: 'نشست نامعتبر است — دوباره وارد شو' });
    const user = getDb().get('SELECT * FROM users WHERE id = ?', data.sub);
    if (!user) return res.status(401).json({ success: false, message: 'کاربر پیدا نشد' });
    /*
     * بن باید همان لحظه اثر کند، نه فقط هنگام ورود بعدی: توکنِ HMAC تا
     * ساعت‌ها اعتبار دارد وگرنه کاربرِ بن‌شده تا انقضای توکن کارش را می‌کرد.
     */
    if (user.banned) {
        return res.status(403).json({
            success: false, banned: true,
            message: 'حساب کاربری تو مسدود شده است' + (user.banned_reason ? ' — ' + user.banned_reason : '')
        });
    }
    const db = getDb();
    db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', now(), user.id);
    /* آخرین IP را نگه می‌داریم تا موقع بن‌کردن، همان بن شود */
    ban.rememberIp(db, user.id, req.clientIp || ban.clientIp(req));
    req.user = user;
    next();
}

function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ success: false, message: 'وارد نشده‌ای' });
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'فقط مدیر سیستم' });
    next();
}

module.exports = {
    makePasswordRecord,
    checkPassword,
    signToken,
    verifyToken,
    requireAuth,
    requireAdmin,
    publicUser
};
