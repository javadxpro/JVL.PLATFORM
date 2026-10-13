'use strict';

/** اکسپلور: پست‌ها، لایک، کامنت، بازدید/تاریخچه و استوری‌ها */

const express = require('express');
const { getDb, now, plusHours } = require('../db');
const Config = require('../config');
const { requireAuth } = require('../auth');
const {
    allPosts, serializePost, activeStories, pruneStories, pushNotification
} = require('../services');
const { uploadOne, commit, multerErrorHandler } = require('../storage');
const rt = require('../realtime');

const router = express.Router();

/* ───────── پست‌ها ───────── */

router.get('/posts', requireAuth, (req, res) => {
    res.json(allPosts(req.user.id));
});

router.post('/create_post', requireAuth, uploadOne, multerErrorHandler, (req, res) => {
    const db = getDb();
    const content = String((req.body && req.body.content) || '').trim();
    let file = null;
    if (req.file) {
        const out = commit(req.file, 'posts');
        if (out.error) return res.json({ success: false, message: out.error });
        file = out.file;
    }
    if (!content && !file) return res.json({ success: false, message: 'متن بنویس یا فایل انتخاب کن' });

    const { lastId } = db.run(
        'INSERT INTO posts (user_id, content, file_path, file_name, file_type, views, timestamp) VALUES (?,?,?,?,?,0,?)',
        req.user.id, content,
        file ? file.file_path : null, file ? file.file_name : null, file ? file.file_type : null,
        now()
    );
    res.json({ success: true, post: serializePost(db.get('SELECT p.*, u.full_name, u.username, u.avatar FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id = ?', lastId), req.user.id) });
});

router.post('/like_post/:pid', requireAuth, (req, res) => {
    const db = getDb();
    const pid = Number(req.params.pid);
    const me = req.user.id;
    if (!db.get('SELECT id FROM posts WHERE id = ?', pid)) {
        return res.status(404).json({ success: false, message: 'پست پیدا نشد' });
    }
    const liked = !db.get('SELECT 1 AS x FROM post_likes WHERE post_id = ? AND user_id = ?', pid, me);
    if (liked) db.run('INSERT INTO post_likes (post_id, user_id, timestamp) VALUES (?,?,?)', pid, me, now());
    else db.run('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?', pid, me);

    const likes_count = db.count('SELECT 1 FROM post_likes WHERE post_id = ?', pid);
    rt.broadcast('post_like', { post_id: pid, likes_count, liked, user_id: me });
    if (liked) {
        const owner = db.get('SELECT user_id FROM posts WHERE id = ?', pid);
        if (owner) pushNotification(owner.user_id, me, 'like', pid);
    }
    res.json({ success: true, liked, likes_count });
});

router.post('/view_post/:pid', requireAuth, (req, res) => {
    const db = getDb();
    const pid = Number(req.params.pid);
    const me = req.user.id;
    if (!db.get('SELECT id FROM posts WHERE id = ?', pid)) {
        return res.status(404).json({ success: false, message: 'پست پیدا نشد' });
    }
    db.run(
        'INSERT OR IGNORE INTO post_views (post_id, user_id, viewed_at) VALUES (?,?,?)', pid, me, now()
    );
    db.run('UPDATE posts SET views = views + 1 WHERE id = ?', pid);
    const views = Number(db.get('SELECT views FROM posts WHERE id = ?', pid).views);
    rt.broadcast('post_view', { post_id: pid, views });
    res.json({ success: true, views });
});

router.get('/post_comments/:pid', requireAuth, (req, res) => {
    const pid = Number(req.params.pid);
    const rows = getDb().all(`
        SELECT c.id, c.content, c.timestamp, u.id AS user_id, u.full_name, u.username, u.avatar
        FROM post_comments c JOIN users u ON u.id = c.user_id
        WHERE c.post_id = ?
        ORDER BY c.timestamp ASC, c.id ASC
    `, pid);
    res.json(rows.map(c => ({
        id: c.id,
        user_id: c.user_id,
        full_name: c.full_name,
        username: c.username,
        avatar: c.avatar || null,
        content: c.content,
        timestamp: c.timestamp
    })));
});

router.post('/comment_post/:pid', requireAuth, (req, res) => {
    const db = getDb();
    const pid = Number(req.params.pid);
    const me = req.user.id;
    const content = String((req.body && req.body.content) || '').trim();
    if (!content) return res.json({ success: false, message: 'متن نظر خالی است' });
    const post = db.get('SELECT * FROM posts WHERE id = ?', pid);
    if (!post) return res.status(404).json({ success: false, message: 'پست پیدا نشد' });

    const { lastId } = db.run(
        'INSERT INTO post_comments (post_id, user_id, content, timestamp) VALUES (?,?,?,?)', pid, me, content, now()
    );
    const comments_count = db.count('SELECT 1 FROM post_comments WHERE post_id = ?', pid);
    rt.broadcast('post_comment', { post_id: pid, comments_count, user_id: me });
    pushNotification(post.user_id, me, 'comment', pid);
    res.json({ success: true, comment_id: lastId, comments_count });
});

/* تاریخچهٔ تماشای ویدیوها */
router.get('/history/:uid', requireAuth, (req, res) => {
    const db = getDb();
    const uid = Number(req.params.uid) || req.user.id;
    const rows = db.all(`
        SELECT p.*, u.full_name, u.username, u.avatar
        FROM post_views v
        JOIN posts p ON p.id = v.post_id
        JOIN users u ON u.id = p.user_id
        WHERE v.user_id = ?
        ORDER BY v.viewed_at DESC, v.post_id DESC
    `, uid);
    res.json(rows.map(r => serializePost(r, req.user.id)));
});

/* ───────── استوری ───────── */

router.get('/stories', requireAuth, (req, res) => {
    pruneStories();
    res.json(activeStories(req.user.id));
});

router.post('/create_story', requireAuth, uploadOne, multerErrorHandler, (req, res) => {
    const db = getDb();
    if (!req.file) return res.json({ success: false, message: 'یک عکس یا ویدیو انتخاب کن' });
    const out = commit(req.file, 'stories');
    if (out.error) return res.json({ success: false, message: out.error });
    const file = out.file;
    if (file.file_type === 'audio' || file.file_type === 'file') {
        const { removeFile } = require('../storage');
        removeFile('stories', file.file_path);
        return res.json({ success: false, message: 'فقط عکس یا ویدیو برای استوری' });
    }
    const created = now();
    const { lastId } = db.run(
        'INSERT INTO stories (user_id, file_path, file_name, file_type, created_at, expires_at) VALUES (?,?,?,?,?,?)',
        req.user.id, file.file_path, file.file_name, file.file_type, created,
        plusHours(Config.storyTtlHours)
    );
    res.json({ success: true, story_id: lastId, expires_at: plusHours(Config.storyTtlHours) });
});

router.post('/view_story/:sid', requireAuth, (req, res) => {
    const db = getDb();
    const sid = Number(req.params.sid);
    const me = req.body && req.body.user_id ? Number(req.body.user_id) : req.user.id;
    if (!db.get('SELECT id FROM stories WHERE id = ?', sid)) {
        return res.status(404).json({ success: false, message: 'استوری پیدا نشد' });
    }
    db.run('INSERT OR IGNORE INTO story_views (story_id, user_id, viewed_at) VALUES (?,?,?)', sid, me, now());
    res.json({ success: true });
});

router.get('/story_views/:sid', requireAuth, (req, res) => {
    const db = getDb();
    const sid = Number(req.params.sid);
    const story = db.get('SELECT * FROM stories WHERE id = ?', sid);
    if (!story) return res.status(404).json({ success: false, message: 'استوری پیدا نشد' });
    if (story.user_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'فقط صاحب استوری بیننده‌ها را می‌بیند' });
    }
    const viewers = db.all(`
        SELECT u.id, u.full_name, u.username, u.avatar
        FROM story_views v JOIN users u ON u.id = v.user_id
        WHERE v.story_id = ? AND v.user_id != ?
        ORDER BY v.viewed_at DESC
    `, sid, story.user_id);
    res.json({
        success: true,
        viewers: viewers.map(v => ({ id: v.id, full_name: v.full_name, username: v.username, avatar: v.avatar || null }))
    });
});

module.exports = router;
