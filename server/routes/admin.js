'use strict';

/** پنل مدیریت: آمار، مدیریت کاربران/پست‌ها و پاک‌سازی */

const express = require('express');
const { getDb, now } = require('../db');
const { requireAuth, requireAdmin, publicUser } = require('../auth');
const { serializeUser, deletePostRow, pruneStories } = require('../services');
const { removeFile } = require('../storage');
const rt = require('../realtime');

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get('/stats', (req, res) => {
    const db = getDb();
    pruneStories();
    res.json({
        total_users: db.count('SELECT 1 FROM users'),
        total_groups: db.count('SELECT 1 FROM groups'),
        total_messages: db.count('SELECT 1 FROM messages'),
        total_posts: db.count('SELECT 1 FROM posts'),
        total_likes: db.count('SELECT 1 FROM post_likes'),
        total_comments: db.count('SELECT 1 FROM post_comments'),
        total_follows: db.count('SELECT 1 FROM follows'),
        active_stories: db.count('SELECT 1 FROM stories WHERE expires_at > ?', now()),
        online_now: rt.onlineIds().length,
        generated_at: now()
    });
});

router.get('/users', (req, res) => {
    const db = getDb();
    const rows = db.all('SELECT * FROM users ORDER BY role DESC, id ASC');
    res.json(rows.map(u => ({
        ...serializeUser(u),
        posts_count: db.count('SELECT 1 FROM posts WHERE user_id = ?', u.id),
        messages_count: db.count('SELECT 1 FROM messages WHERE sender_id = ?', u.id),
        last_seen_at: u.last_seen_at
    })));
});

router.delete('/delete_user/:id', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    if (id === req.user.id) return res.json({ success: false, message: 'نمی‌توانی حساب خودت را حذف کنی' });
    const user = db.get('SELECT * FROM users WHERE id = ?', id);
    if (!user) return res.status(404).json({ success: false, message: 'کاربر پیدا نشد' });

    /* پاک‌کردن فایل‌ها پیش از حذف ردیف‌ها (CASCADE) */
    for (const r of db.all('SELECT file_path FROM messages WHERE file_path IS NOT NULL AND (sender_id = ? OR receiver_id = ?)', id, id)) {
        removeFile('chat', r.file_path);
    }
    for (const r of db.all('SELECT file_path FROM posts WHERE file_path IS NOT NULL AND user_id = ?', id)) {
        removeFile('posts', r.file_path);
    }
    for (const r of db.all('SELECT file_path FROM stories WHERE file_path IS NOT NULL AND user_id = ?', id)) {
        removeFile('stories', r.file_path);
    }
    if (user.avatar) removeFile('profiles', user.avatar);
    for (const r of db.all('SELECT id FROM lan_hosts WHERE user_id = ?', id)) {
        db.run('DELETE FROM lan_hosts WHERE id = ?', r.id);
    }

    db.run('DELETE FROM users WHERE id = ?', id);
    rt.broadcastUserStatus();
    res.json({ success: true, message: 'کاربر حذف شد' });
});

router.post('/promote_user/:id', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const user = db.get('SELECT * FROM users WHERE id = ?', id);
    if (!user) return res.status(404).json({ success: false, message: 'کاربر پیدا نشد' });
    db.run('UPDATE users SET role = ? WHERE id = ?', 'admin', id);
    res.json({ success: true, user: publicUser(db.get('SELECT * FROM users WHERE id = ?', id)) });
});

router.post('/demote_user/:id', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    if (id === req.user.id) return res.json({ success: false, message: 'نمی‌توانی دسترسی خودت را بگیری' });
    const user = db.get('SELECT * FROM users WHERE id = ?', id);
    if (!user) return res.status(404).json({ success: false, message: 'کاربر پیدا نشد' });
    db.run('UPDATE users SET role = ? WHERE id = ?', 'user', id);
    res.json({ success: true, user: publicUser(db.get('SELECT * FROM users WHERE id = ?', id)) });
});

router.delete('/delete_post/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!deletePostRow(id)) return res.status(404).json({ success: false, message: 'پست پیدا نشد' });
    rt.broadcast('post_deleted', { post_id: id });
    res.json({ success: true, message: 'پست حذف شد' });
});

router.delete('/clear_all_messages', (req, res) => {
    const db = getDb();
    const files = db.all('SELECT file_path FROM messages WHERE file_path IS NOT NULL');
    const removed = db.run('DELETE FROM messages').changes;
    db.run('DELETE FROM group_reads');
    for (const f of files) removeFile('chat', f.file_path);
    rt.broadcast('message_deleted', { all: true, by: req.user.id });
    res.json({ success: true, removed });
});

module.exports = router;
