'use strict';

/** ورود و ثبت‌نام — مسیرهایی که کلاینت مستقیماً و بدون توکن صدا می‌زند. */

const express = require('express');
const Config = require('../config');
const { getDb, now } = require('../db');
const { makePasswordRecord, checkPassword, signToken, publicUser } = require('../auth');
const rt = require('../realtime');
const ban = require('../ban');

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_.]{3,32}$/;

function cleanUsername(v) {
    return String(v == null ? '' : v).trim();
}

router.post('/register', (req, res) => {
    const db = getDb();
    const username = cleanUsername(req.body && req.body.username);
    const password = String((req.body && req.body.password) || '');

    if (!USERNAME_RE.test(username)) {
        return res.json({ success: false, message: 'نام کاربری باید ۳ تا ۳۲ کاراکتر انگلیسی (حرف، عدد، نقطه یا _) باشد' });
    }
    if (password.length < 4) {
        return res.json({ success: false, message: 'رمز عبور حداقل ۴ کاراکتر باشد' });
    }
    if (db.get('SELECT id FROM users WHERE username = ?', username)) {
        return res.json({ success: false, message: 'این نام کاربری قبلاً گرفته شده' });
    }

    const isAdmin = Config.firstUserIsAdmin && db.count('SELECT 1 FROM users') === 0;
    const { lastId } = db.run(
        'INSERT INTO users (username, password_hash, full_name, bio, avatar, role, created_at) VALUES (?,?,?,?,NULL,?,?)',
        username, makePasswordRecord(password), username, '', isAdmin ? 'admin' : 'user', now()
    );

    rt.broadcastUserStatus();
    return res.json({
        success: true,
        message: isAdmin ? 'حساب ساخته شد — تو اولین مدیر این شبکه‌ای 👑 حالا وارد شو' : 'حساب ساخته شد ✅ حالا وارد شو',
        user: publicUser(db.get('SELECT * FROM users WHERE id = ?', lastId))
    });
});

router.post('/login', (req, res) => {
    const db = getDb();
    const username = cleanUsername(req.body && req.body.username);
    const password = String((req.body && req.body.password) || '');
    const user = db.get('SELECT * FROM users WHERE username = ?', username);
    if (!user || !checkPassword(password, user.password_hash)) {
        return res.status(401).json({ success: false, message: 'نام کاربری یا رمز عبور اشتباه است' });
    }
    /*
     * عمداً بعد از بررسی رمز: تا رمز درست نباشد نمی‌گوییم حساب بن شده،
     * وگرنه فهرستِ حساب‌های بن‌شده لو می‌رود.
     */
    if (user.banned) {
        return res.status(403).json({
            success: false, banned: true,
            message: 'حساب کاربری تو مسدود شده است' + (user.banned_reason ? ' — ' + user.banned_reason : '')
        });
    }
    db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', now(), user.id);
    /* برای بن‌شدنِ بعدی، IP همین نشست را نگه می‌داریم */
    ban.rememberIp(db, user.id, req.clientIp || ban.clientIp(req));
    rt.broadcastUserStatus();
    return res.json({ success: true, user: publicUser(user), token: signToken(user.id) });
});

module.exports = router;
