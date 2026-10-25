'use strict';

/** کاربران، پروفایل عمومی، دنبال‌کردن و اعلان‌ها */

const express = require('express');
const { getDb, now } = require('../db');
const { requireAuth } = require('../auth');
const { serializeUser, pushNotification } = require('../services');
const rt = require('../realtime');

const router = express.Router();

/* لیست کاربران (کلاینت خودش را فیلتر می‌کند) */
router.get('/users', requireAuth, (req, res) => {
    const rows = getDb().all('SELECT * FROM users ORDER BY role DESC, full_name COLLATE NOCASE ASC, id ASC');
    res.json(rows.map(serializeUser));
});

/* شمار پیام‌های خوانده‌نشده به تفکیک فرستنده: { "3": 2 } */
router.get('/unread_counts/:me', requireAuth, (req, res) => {
    const me = Number(req.params.me) || req.user.id;
    const rows = getDb().all(
        'SELECT sender_id, COUNT(*) AS n FROM messages WHERE receiver_id = ? AND seen = 0 GROUP BY sender_id', me
    );
    const out = {};
    for (const r of rows) out[r.sender_id] = Number(r.n);
    res.json(out);
});

/* پروفایل: آمار پست/فالوور/دنبال‌شده + وضعیت دنبال‌کردن */
router.get('/user_profile/:me/:uid', requireAuth, (req, res) => {
    const db = getDb();
    const me = Number(req.params.me) || req.user.id;
    const uid = Number(req.params.uid);
    const u = db.get('SELECT * FROM users WHERE id = ?', uid);
    if (!u) return res.status(404).json({ success: false, message: 'کاربر پیدا نشد' });
    res.json({
        id: u.id,
        username: u.username,
        full_name: u.full_name,
        bio: u.bio || '',
        avatar: u.avatar || null,
        role: u.role,
        created_at: u.created_at,
        is_online: rt.isOnline(u.id),
        posts_count: db.count('SELECT 1 FROM posts WHERE user_id = ?', uid),
        followers: db.count('SELECT 1 FROM follows WHERE followee_id = ?', uid),
        following_count: db.count('SELECT 1 FROM follows WHERE follower_id = ?', uid),
        is_following: !!(me !== uid && db.get('SELECT 1 AS x FROM follows WHERE follower_id = ? AND followee_id = ?', me, uid))
    });
});

/* دنبال‌کردن / لغو دنبال‌کردن */
router.post('/follow/:uid', requireAuth, (req, res) => {
    const db = getDb();
    const me = req.user.id;
    const uid = Number(req.params.uid);
    if (!uid || uid === me) return res.json({ success: false, message: 'نمی‌توانی خودت را دنبال کنی' });
    if (!db.get('SELECT id FROM users WHERE id = ?', uid)) {
        return res.status(404).json({ success: false, message: 'کاربر پیدا نشد' });
    }
    const existing = db.get('SELECT 1 AS x FROM follows WHERE follower_id = ? AND followee_id = ?', me, uid);
    let following;
    if (existing) {
        db.run('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?', me, uid);
        following = false;
    } else {
        db.run('INSERT INTO follows (follower_id, followee_id, timestamp) VALUES (?,?,?)', me, uid, now());
        following = true;
        pushNotification(uid, me, 'follow', null);
    }
    rt.broadcast('follow_update', { target_id: uid, follower_id: me, following });
    res.json({ success: true, following });
});

/* اعلان‌ها */
router.get('/notifications/:uid', requireAuth, (req, res) => {
    const db = getDb();
    const uid = Number(req.params.uid) || req.user.id;
    const items = db.all(`
        SELECT n.id, n.type, n.post_id, n.is_read, n.timestamp, n.actor_id, u.full_name AS actor_name
        FROM notifications n JOIN users u ON u.id = n.actor_id
        WHERE n.user_id = ?
        ORDER BY n.timestamp DESC, n.id DESC
        LIMIT 60
    `, uid).map(n => ({
        id: n.id,
        type: n.type,
        post_id: n.post_id,
        actor_id: n.actor_id,
        actor_name: n.actor_name,
        is_read: !!n.is_read,
        timestamp: n.timestamp
    }));
    res.json({ unread: items.filter(n => !n.is_read).length, items });
});

router.post('/notifications_read/:uid', requireAuth, (req, res) => {
    const uid = Number(req.params.uid) || req.user.id;
    getDb().run('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', uid);
    res.json({ success: true });
});

module.exports = router;
