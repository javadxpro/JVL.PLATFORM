'use strict';

/**
 * رویدادها — بخش «کشف رویدادها» در نقشه‌راه.
 *
 * عمداً جمع‌وجور است: یک رویداد = عنوان، توضیح، مکان، زمان شروع، میزبان.
 * نه تصویر جلد، نه تکرار، نه یادآور — تا وقتی ضرورتشان ثابت نشود اضافه
 * نمی‌شوند (اصل شمارهٔ ۶ نقشه‌راه).
 *
 * شکل پاسخ‌ها عمداً با لایهٔ MQTT مرورگر (static/js/mqtt-backend.js) یکی است تا
 * کلاینت در هر دو حالت — سرور نود و Pages استاتیک — یکسان کار کند.
 */

const express = require('express');
const { getDb, now } = require('../db');
const { requireAuth, publicUser } = require('../auth');
const rt = require('../realtime');

const router = express.Router();

/* ───────── ابزار ───────── */

const STATUSES = new Set(['going', 'maybe']);

/**
 * زمان شروع را به قالب «yyyy-MM-dd HH:mm:ss» همان‌جای بقیهٔ کدبیس می‌برد.
 * ورودیِ `<input type="datetime-local">` به شکل «yyyy-MM-ddTHH:mm» است.
 *
 * عمداً منطقهٔ زمانی نگه داشته نمی‌شود: بقیهٔ پلتفرم هم زمان محلیِ بدون
 * منطقه می‌نویسد، و قاطی‌کردن دو قالب باعث می‌شد رویدادها بد مرتب شوند.
 */
function normalizeStartsAt(raw) {
    const s = String(raw || '').trim().replace('T', ' ');
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (!m) return null;
    const [, y, mo, d, h, mi, se] = m;
    /* ماه ۱–۱۲، روز ۱–۳۱، ساعت ۰–۲۳، دقیقه ۰–۵۹ */
    if (!(+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31 && +h <= 23 && +mi <= 59)) return null;
    return `${y}-${mo}-${d} ${h}:${mi}:${se || '00'}`;
}

function rsvpCounts(db, eventId) {
    const rows = db.all(
        'SELECT status, COUNT(*) AS c FROM event_rsvps WHERE event_id = ? GROUP BY status', eventId
    );
    const out = { going: 0, maybe: 0 };
    for (const r of rows) if (out[r.status] !== undefined) out[r.status] = r.c;
    return out;
}

function serializeEvent(db, ev, meId) {
    const counts = rsvpCounts(db, ev.id);
    const mine = meId
        ? db.get('SELECT status FROM event_rsvps WHERE event_id = ? AND user_id = ?', ev.id, meId)
        : null;
    const host = db.get('SELECT * FROM users WHERE id = ?', ev.host_id);
    return {
        id: ev.id,
        title: ev.title,
        description: ev.description || '',
        place: ev.place || '',
        starts_at: ev.starts_at,
        host_id: ev.host_id,
        host_name: host ? (host.full_name || host.username) : '',
        is_public: !!ev.is_public,
        created_at: ev.created_at,
        going_count: counts.going,
        maybe_count: counts.maybe,
        my_rsvp: mine ? mine.status : null,
        /* رویدادی که زمان شروعش گذشته؛ کلاینت با این جدا می‌کند، نه با حدس */
        is_past: ev.starts_at < now()
    };
}

function findEvent(db, id) {
    return db.get('SELECT * FROM events WHERE id = ?', Number(id)) || null;
}

/* ───────── مسیرها ───────── */

/** ساخت رویداد */
router.post('/create_event', requireAuth, (req, res) => {
    const db = getDb();
    const title = String(req.body.title || '').trim().slice(0, 120);
    if (!title) return res.status(400).json({ success: false, message: 'عنوان رویداد لازم است' });

    const startsAt = normalizeStartsAt(req.body.starts_at);
    if (!startsAt) {
        return res.status(400).json({ success: false, message: 'زمان شروع معتبر نیست' });
    }

    const info = db.run(
        `INSERT INTO events (title, description, place, starts_at, host_id, is_public, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        title,
        String(req.body.description || '').trim().slice(0, 2000),
        String(req.body.place || '').trim().slice(0, 200),
        startsAt,
        req.user.id,
        req.body.is_public === false ? 0 : 1,
        now()
    );
    const ev = findEvent(db, info.lastId);
    rt.broadcast('events_changed', { at: now() });
    res.json({ success: true, event: serializeEvent(db, ev, req.user.id) });
});

/** فهرست رویدادها — آینده first، سپس گذشته */
router.get('/events', requireAuth, (req, res) => {
    const db = getDb();
    const rows = db.all('SELECT * FROM events ORDER BY starts_at ASC, id ASC');
    const list = rows
        .filter(ev => ev.is_public || ev.host_id === req.user.id)
        .map(ev => serializeEvent(db, ev, req.user.id));
    /* گذشته‌ها ته فهرست، وگرنه رویدادِ تمام‌شده جای رویدادِ بعدی را می‌گیرد */
    list.sort((a, b) => (a.is_past - b.is_past) || (a.starts_at < b.starts_at ? -1 : 1));
    res.json(list);
});

/** یک رویداد */
router.get('/event/:id', requireAuth, (req, res) => {
    const db = getDb();
    const ev = findEvent(db, req.params.id);
    if (!ev) return res.status(404).json({ success: false, message: 'رویداد پیدا نشد' });
    if (!ev.is_public && ev.host_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'این رویداد خصوصی است' });
    }
    res.json(serializeEvent(db, ev, req.user.id));
});

/** حاضران یک رویداد */
router.get('/event_rsvps/:id', requireAuth, (req, res) => {
    const db = getDb();
    const ev = findEvent(db, req.params.id);
    if (!ev) return res.status(404).json({ success: false, message: 'رویداد پیدا نشد' });
    const rows = db.all(
        `SELECT u.*, r.status, r.created_at AS rsvp_at
           FROM event_rsvps r JOIN users u ON u.id = r.user_id
          WHERE r.event_id = ? ORDER BY r.created_at ASC`,
        ev.id
    );
    res.json(rows.map(r => Object.assign({}, publicUser(r), {
        rsvp: r.status, rsvp_at: r.rsvp_at
    })));
});

/**
 * پاسخ به رویداد: `going` یا `maybe`.
 * وضعیت `no` (یا هر چیز دیگر) یعنی انصراف و ردیف پاک می‌شود — این‌طور
 * «نمی‌آیم» با «هنوز جواب ندادم» قاطی نمی‌شود.
 */
router.post('/event_rsvp/:id', requireAuth, (req, res) => {
    const db = getDb();
    const ev = findEvent(db, req.params.id);
    if (!ev) return res.status(404).json({ success: false, message: 'رویداد پیدا نشد' });
    if (!ev.is_public && ev.host_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'این رویداد خصوصی است' });
    }
    if (ev.starts_at < now()) {
        return res.status(400).json({ success: false, message: 'این رویداد تمام شده است' });
    }

    const status = String(req.body.status || '').trim();
    if (status && !STATUSES.has(status)) {
        return res.status(400).json({ success: false, message: 'وضعیت نامعتبر است' });
    }

    if (status) {
        db.run(
            `INSERT INTO event_rsvps (event_id, user_id, status, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(event_id, user_id) DO UPDATE SET status = excluded.status`,
            ev.id, req.user.id, status, now()
        );
    } else {
        db.run('DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?', ev.id, req.user.id);
    }

    rt.broadcast('events_changed', { at: now() });
    res.json({ success: true, event: serializeEvent(db, findEvent(db, ev.id), req.user.id) });
});

/** حذف رویداد — فقط میزبان یا مدیر */
router.delete('/event/:id', requireAuth, (req, res) => {
    const db = getDb();
    const ev = findEvent(db, req.params.id);
    if (!ev) return res.status(404).json({ success: false, message: 'رویداد پیدا نشد' });
    if (ev.host_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'فقط میزبان یا مدیر می‌تواند رویداد را حذف کند' });
    }
    db.run('DELETE FROM events WHERE id = ?', ev.id);
    rt.broadcast('events_changed', { at: now() });
    res.json({ success: true, message: 'رویداد حذف شد' });
});

module.exports = router;
