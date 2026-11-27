'use strict';

/**
 * همسان‌سازی مخاطبین: ثبت شمارهٔ خود و پیدا کردن آشناها از روی هش.
 *
 * شمارهٔ خام هرگز ذخیره نمی‌شود؛ فقط `p` + ۲۴ رقمِ هش در `users.phone_hash`
 * می‌نشیند. همان قرارداد در `static/js/mqtt-backend.js` هم پیاده شده تا دو
 * حالت واگرا نمانند.
 */

const express = require('express');
const { getDb } = require('../db');
const { requireAuth } = require('../auth');
const { phoneHash } = require('../phone');
const rt = require('../realtime');

const router = express.Router();

/* سقف همان چیزی است که لایهٔ MQTT هم رعایت می‌کند */
const MAX_LOOKUP = 2000;

/* ثبت شمارهٔ خود کاربر */
router.post('/set_phone', requireAuth, (req, res) => {
    const db = getDb();
    const hash = phoneHash(req.body && req.body.phone);
    if (!hash) return res.json({ success: false, message: 'شماره معتبر نیست' });

    const taken = db.get('SELECT id FROM users WHERE phone_hash = ?', hash);
    if (taken && taken.id !== req.user.id) {
        return res.status(409).json({ success: false, message: 'این شماره به حساب دیگری وصل است' });
    }
    db.run('UPDATE users SET phone_hash = ? WHERE id = ?', hash, req.user.id);
    res.json({ success: true });
});

/** شمارهٔ خام → هش؛ تا نامِ دفترچه تلفن به کاربرِ پیدا‌شده گره بخورد */
router.post('/phone_hash', requireAuth, (req, res) => {
    const hash = phoneHash(req.body && req.body.phone);
    if (!hash) return res.json({ success: false, message: 'شماره معتبر نیست' });
    res.json({ hash });
});

/*
 * ورودی می‌تواند هش (`p…`) یا شمارهٔ خام باشد — مثل لایهٔ MQTT هر دو
 * پذیرفته می‌شود. شمارهٔ خودِ کاربر فیلتر می‌شود، چون مخاطبِ خودش نیست.
 */
router.post('/contacts_lookup', requireAuth, (req, res) => {
    const db = getDb();
    const me = req.user.id;
    const raw = Array.isArray(req.body && req.body.hashes) ? req.body.hashes.slice(0, MAX_LOOKUP) : [];

    const keys = [];
    const seen = new Set();
    for (const h of raw) {
        const key = String(h).startsWith('p') ? String(h) : phoneHash(h);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        keys.push(key);
    }

    const matches = [];
    if (keys.length) {
        const ph = keys.map(() => '?').join(',');
        const rows = db.all(`SELECT id, username, full_name, avatar, phone_hash FROM users WHERE phone_hash IN (${ph})`, ...keys);
        for (const u of rows) {
            if (u.id === me) continue;
            matches.push({
                hash: u.phone_hash,
                id: u.id,
                username: u.username,
                full_name: u.full_name,
                avatar: u.avatar || null,
                is_online: rt.isOnline(u.id)
            });
        }
    }
    res.json({ matches, checked: raw.length });
});

module.exports = router;
