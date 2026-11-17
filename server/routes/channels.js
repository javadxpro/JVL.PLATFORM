'use strict';

/**
 * کانال‌ها (Broadcasting): فقط مالک منتشر می‌کند، بقیه عضو می‌شوند و می‌خوانند.
 *
 * شکل پاسخ‌ها عمداً با لایهٔ MQTT مرورگر (static/js/mqtt-backend.js) یکی است تا
 * کلاینت در هر دو حالت — سرور نود و Pages استاتیک — یکسان کار کند.
 */

const express = require('express');
const { getDb, now } = require('../db');
const { requireAuth } = require('../auth');
const { uploadOne, commit, multerErrorHandler } = require('../storage');
const rt = require('../realtime');

const router = express.Router();

/* ───────── ابزار ───────── */

function channelRow(db, cid) {
    return db.get('SELECT * FROM channels WHERE id = ?', cid) || null;
}

function subIds(db, cid) {
    return db.all('SELECT user_id FROM channel_subs WHERE channel_id = ?', cid).map(r => r.user_id);
}

function ownerName(db, ownerId) {
    const u = db.get('SELECT full_name FROM users WHERE id = ?', ownerId);
    return u ? u.full_name : 'نامشخص';
}

function serializeChannel(db, row, myId) {
    const subs = subIds(db, row.id);
    const posts = db.get('SELECT COUNT(*) AS n FROM channel_posts WHERE channel_id = ?', row.id).n;
    return {
        id: row.id,
        name: row.name,
        bio: row.bio || '',
        avatar: row.avatar || null,
        owner_id: row.owner_id,
        owner_name: ownerName(db, row.owner_id),
        created_at: row.created_at,
        public: !!row.is_public,
        subscribers: subs.length,
        subscribed: subs.indexOf(myId) >= 0,
        posts,
        is_owner: row.owner_id === myId
    };
}

function serializeChannelPost(db, row, myId) {
    const author = db.get('SELECT full_name FROM users WHERE id = ?', row.author_id);
    const views = db.get('SELECT COUNT(*) AS n FROM channel_post_views WHERE post_id = ?', row.id).n;
    const mine = db.get('SELECT 1 AS x FROM channel_post_views WHERE post_id = ? AND user_id = ?', row.id, myId);
    const comments = db.get('SELECT COUNT(*) AS n FROM channel_comments WHERE post_id = ?', row.id).n;
    return {
        id: row.id,
        channel_id: row.channel_id,
        author_id: row.author_id,
        author_name: author ? author.full_name : 'کانال',
        content: row.content || '',
        media: row.file_path || null,
        file_type: row.file_type || null,
        file_name: row.file_name || null,
        timestamp: row.created_at,
        views,
        viewed_by_me: !!mine,
        comments
    };
}

/* ───────── ساخت و لیست ───────── */

router.post('/create_channel', requireAuth, (req, res) => {
    const db = getDb();
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.json({ success: false, message: 'نام کانال را بنویس' });
    if (name.length > 60) return res.json({ success: false, message: 'نام کانال خیلی بلند است' });
    const dup = db.get('SELECT id FROM channels WHERE owner_id = ? AND name = ?', req.user.id, name);
    if (dup) return res.json({ success: false, message: 'کانالی با این نام داری' });

    const isPublic = !(req.body && req.body.public === false);
    const { lastId } = db.run(
        'INSERT INTO channels (name, bio, owner_id, is_public, created_at) VALUES (?,?,?,?,?)',
        name, String((req.body && req.body.bio) || '').slice(0, 200), req.user.id, isPublic ? 1 : 0, now()
    );
    db.run('INSERT INTO channel_subs (channel_id, user_id, joined_at) VALUES (?,?,?)', lastId, req.user.id, now());

    const row = channelRow(db, lastId);
    rt.broadcast('channels_changed', { channel_id: lastId });
    res.json({
        success: true,
        message: `کانال «${name}» ساخته شد 📢`,
        channel_id: lastId,
        channel: serializeChannel(db, row, req.user.id)
    });
});

router.get('/channels', requireAuth, (req, res) => {
    const db = getDb();
    const rows = db.all('SELECT * FROM channels ORDER BY id DESC');
    const list = rows.map(r => serializeChannel(db, r, req.user.id));
    /* عضو‌شده‌ها اول، بعد بقیه؛ داخل هر گروه تازه‌ترها بالا */
    list.sort((a, b) => (b.subscribed - a.subscribed) || (b.id - a.id));
    res.json(list);
});

router.get('/channel_info/:cid', requireAuth, (req, res) => {
    const db = getDb();
    const row = channelRow(db, Number(req.params.cid));
    if (!row) return res.status(404).json({ success: false, message: 'کانال پیدا نشد' });
    res.json(serializeChannel(db, row, req.user.id));
});

/* ───────── عضویت ───────── */

router.post('/channel_subscribe/:cid', requireAuth, (req, res) => {
    const db = getDb();
    const cid = Number(req.params.cid);
    const row = channelRow(db, cid);
    if (!row) return res.status(404).json({ success: false, message: 'کانال پیدا نشد' });

    const existing = db.get('SELECT 1 AS x FROM channel_subs WHERE channel_id = ? AND user_id = ?', cid, req.user.id);
    if (existing && row.owner_id === req.user.id) {
        return res.json({ success: false, message: 'مالک کانال نمی‌تواند عضویتش را لغو کند؛ کانال را حذف کن' });
    }
    if (existing) db.run('DELETE FROM channel_subs WHERE channel_id = ? AND user_id = ?', cid, req.user.id);
    else db.run('INSERT INTO channel_subs (channel_id, user_id, joined_at) VALUES (?,?,?)', cid, req.user.id, now());

    rt.broadcast('channels_changed', { channel_id: cid });
    res.json({ success: true, subscribed: !existing, subscribers: subIds(db, cid).length });
});

/* ───────── انتشار ───────── */

router.post('/channel_post/:cid', requireAuth, uploadOne, multerErrorHandler, (req, res) => {
    const db = getDb();
    const cid = Number(req.params.cid);
    const row = channelRow(db, cid);
    if (!row) return res.status(404).json({ success: false, message: 'کانال پیدا نشد' });
    const isAdmin = req.user.role === 'admin';
    if (row.owner_id !== req.user.id && !isAdmin) {
        return res.status(403).json({ success: false, message: 'فقط مالک کانال می‌تواند پست بگذارد' });
    }

    const content = String((req.body && req.body.content) || '').trim();
    let file = null;
    if (req.file) {
        const out = commit(req.file, 'channels');
        if (out.error) return res.json({ success: false, message: out.error });
        file = out.file;
    }
    if (!content && !file) return res.json({ success: false, message: 'متن بنویس یا فایل انتخاب کن' });

    const { lastId } = db.run(
        'INSERT INTO channel_posts (channel_id, author_id, content, file_path, file_name, file_type, created_at) VALUES (?,?,?,?,?,?,?)',
        cid, req.user.id, content,
        file ? file.file_path : null, file ? file.file_name : null, file ? file.file_type : null,
        now()
    );

    /* به مشترک‌ها خبر می‌دهیم تا فیدشان تازه شود */
    const targets = subIds(db, cid).filter(id => id !== req.user.id);
    rt.emitTo(targets, 'channel_post_added', { channel_id: cid, post_id: lastId });
    rt.broadcast('channels_changed', { channel_id: cid });

    const post = db.get('SELECT * FROM channel_posts WHERE id = ?', lastId);
    res.json({ success: true, message: 'منتشر شد 📢', post: serializeChannelPost(db, post, req.user.id) });
});

router.get('/channel_posts/:cid', requireAuth, (req, res) => {
    const db = getDb();
    const cid = Number(req.params.cid);
    if (!channelRow(db, cid)) return res.status(404).json({ success: false, message: 'کانال پیدا نشد' });
    const rows = db.all('SELECT * FROM channel_posts WHERE channel_id = ? ORDER BY id DESC', cid);
    res.json(rows.map(r => serializeChannelPost(db, r, req.user.id)));
});

/* ───────── بازدید و نظر ───────── */

router.post('/channel_view/:pid', requireAuth, (req, res) => {
    const db = getDb();
    const pid = Number(req.params.pid);
    const post = db.get('SELECT * FROM channel_posts WHERE id = ?', pid);
    if (!post) return res.status(404).json({ success: false, message: 'پست پیدا نشد' });
    const seen = db.get('SELECT 1 AS x FROM channel_post_views WHERE post_id = ? AND user_id = ?', pid, req.user.id);
    if (!seen) db.run('INSERT INTO channel_post_views (post_id, user_id, viewed_at) VALUES (?,?,?)', pid, req.user.id, now());
    const views = db.get('SELECT COUNT(*) AS n FROM channel_post_views WHERE post_id = ?', pid).n;
    res.json({ success: true, views });
});

router.post('/channel_comment/:pid', requireAuth, (req, res) => {
    const db = getDb();
    const pid = Number(req.params.pid);
    const post = db.get('SELECT * FROM channel_posts WHERE id = ?', pid);
    if (!post) return res.status(404).json({ success: false, message: 'پست پیدا نشد' });
    const content = String((req.body && req.body.content) || '').trim();
    if (!content) return res.json({ success: false, message: 'متن نظر خالی است' });
    if (content.length > 500) return res.json({ success: false, message: 'نظر خیلی بلند است' });

    const { lastId } = db.run(
        'INSERT INTO channel_comments (post_id, user_id, content, created_at) VALUES (?,?,?,?)',
        pid, req.user.id, content, now()
    );
    /* شکل پاسخ با لایهٔ MQTT یکی باشد */
    res.json({
        success: true,
        comment: {
            id: lastId, pid, cid: post.channel_id, user_id: req.user.id,
            user_name: req.user.full_name || '',
            content, at: now()
        }
    });
});

router.get('/channel_comments/:pid', requireAuth, (req, res) => {
    const db = getDb();
    const pid = Number(req.params.pid);
    const rows = db.all(
        `SELECT c.id, c.post_id AS pid, p.channel_id AS cid, c.user_id, u.full_name AS user_name,
                c.content, c.created_at AS at
           FROM channel_comments c
           JOIN users u ON u.id = c.user_id
           JOIN channel_posts p ON p.id = c.post_id
          WHERE c.post_id = ? ORDER BY c.id ASC`, pid
    );
    res.json(rows);
});

/* ───────── حذف ───────── */

router.delete('/channel_delete/:cid', requireAuth, (req, res) => {
    const db = getDb();
    const cid = Number(req.params.cid);
    const row = channelRow(db, cid);
    if (!row) return res.status(404).json({ success: false, message: 'کانال پیدا نشد' });
    if (row.owner_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'فقط مالک کانال یا مدیر می‌تواند حذف کند' });
    }
    /* ON DELETE CASCADE بقیهٔ جدول‌ها را هم پاک می‌کند */
    db.run('DELETE FROM channels WHERE id = ?', cid);
    rt.broadcast('channels_changed', { channel_id: cid, removed: true });
    res.json({ success: true, message: 'کانال حذف شد' });
});

module.exports = router;
