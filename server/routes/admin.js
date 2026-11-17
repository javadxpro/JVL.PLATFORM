'use strict';

/** پنل مدیریت: آمار، مدیریت کاربران/پست‌ها و پاک‌سازی */

const express = require('express');
const { getDb, now } = require('../db');
const { requireAuth, requireAdmin, publicUser } = require('../auth');
const { serializeUser, deletePostRow, pruneStories } = require('../services');
const { removeFile } = require('../storage');
const rt = require('../realtime');
const ban = require('../ban');

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
        last_seen_at: u.last_seen_at,
        /* وضعیت بن و آخرین IP فقط به مدیر نشان داده می‌شود */
        banned: !!u.banned,
        banned_reason: u.banned_reason || '',
        banned_at: u.banned_at || null,
        last_ip: u.last_ip || null
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

/**
 * بن‌کردن کاربر + IP او.
 *
 * بدنه:
 *   reason   → دلیل (اختیاری)
 *   ban_ip   → پیش‌فرض true؛ IP آخرین نشست کاربر هم بن می‌شود
 *   cidr     → مثلاً 24؛ به‌جای تک‌IP، کل شبکه بن می‌شود
 */
router.post('/ban_user/:id', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    if (id === req.user.id) return res.json({ success: false, message: 'نمی‌توانی خودت را بن کنی' });
    const user = db.get('SELECT * FROM users WHERE id = ?', id);
    if (!user) return res.status(404).json({ success: false, message: 'کاربر پیدا نشد' });

    const reason = String((req.body && req.body.reason) || '').slice(0, 200);
    const wantIp = !(req.body && req.body.ban_ip === false);
    const cidrBits = req.body && req.body.cidr ? Number(req.body.cidr) : null;

    db.run(
        'UPDATE users SET banned = 1, banned_at = ?, banned_by = ?, banned_reason = ? WHERE id = ?',
        now(), req.user.id, reason, id
    );

    let bannedIp = null, ipError = null;
    if (wantIp) {
        const target = cidrBits ? ban.cidrOf(user.last_ip, cidrBits) : user.last_ip;
        if (!target) ipError = 'این کاربر هنوز IP شناخته‌شده‌ای ندارد (یک بار باید وارد شده باشد)';
        else {
            const out = ban.banIp(db, target, req.user.id, reason || `بن‌شدن کاربر ${user.username}`);
            if (out.ok) bannedIp = out.ip; else ipError = out.message;
        }
    }

    /*
     * اول نشانی را می‌بندیم، بعد خودِ کاربر را بیرون می‌اندازیم. اگر
     * اتصال‌های بازِ دیگری از همان IP باشد (مثلاً حساب دوم) آن‌ها هم می‌روند.
     *
     * فقط از kickUser استفاده می‌کنیم: socket.data.userId و عضویت در اتاق هر دو
     * در همان هندلر join تنظیم می‌شوند، پس emitTo هم‌پوشانی کامل داشت و باعث
     * می‌شد رویداد banned دوبار به کلاینت برسد و دو بار نشست پاک شود.
     */
    const kickedIp = bannedIp ? rt.kickIp(bannedIp) : 0;
    const kicked = rt.kickUser(id, reason);
    rt.broadcastUserStatus();
    res.json({
        success: true,
        message: 'کاربر مسدود شد' + (bannedIp ? ` و نشانی ${bannedIp} هم بسته شد` : ''),
        /* publicUser شکل عمومی است؛ وضعیت بن و IP فقط به مدیر می‌رسد */
        user: Object.assign({}, publicUser(db.get('SELECT * FROM users WHERE id = ?', id)), {
            banned: true, banned_reason: reason, last_ip: user.last_ip || null
        }),
        banned_ip: bannedIp,
        ip_error: ipError,
        kicked: Math.max(kicked, kickedIp)
    });
});

router.post('/unban_user/:id', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const user = db.get('SELECT * FROM users WHERE id = ?', id);
    if (!user) return res.status(404).json({ success: false, message: 'کاربر پیدا نشد' });

    db.run('UPDATE users SET banned = 0, banned_at = NULL, banned_by = NULL, banned_reason = ? WHERE id = ?', '', id);
    let unbannedIp = null;
    /* فقط اگر صریحاً خواسته شود؛ وگرنه ممکن است بخواهی کاربر رفع بن شود ولی IP بسته بماند */
    if (req.body && req.body.unban_ip && user.last_ip) {
        if (ban.unbanIp(db, user.last_ip)) unbannedIp = user.last_ip;
    }
    rt.broadcastUserStatus();
    res.json({
        success: true,
        message: 'کاربر رفع بن شد' + (unbannedIp ? ` و ${unbannedIp} هم باز شد` : ''),
        user: Object.assign({}, publicUser(db.get('SELECT * FROM users WHERE id = ?', id)), {
            banned: false, banned_reason: '', last_ip: user.last_ip || null
        }),
        unbanned_ip: unbannedIp
    });
});

/* ───────── مدیریت مستقیم IPها ───────── */

router.get('/banned_ips', (req, res) => {
    const db = getDb();
    res.json(ban.bannedIps(db).map(r => Object.assign({}, r, {
        banned_by_name: r.banned_by ? (db.get('SELECT username FROM users WHERE id = ?', r.banned_by) || {}).username : null
    })));
});

router.post('/ban_ip', (req, res) => {
    const ip = String((req.body && req.body.ip) || '').trim();
    const reason = String((req.body && req.body.reason) || '').slice(0, 200);
    const out = ban.banIp(getDb(), ip, req.user.id, reason);
    if (!out.ok) return res.json({ success: false, message: out.message });
    const kicked = rt.kickIp(out.ip);   /* اگر آنلاین است، همین حالا قطع شود */
    res.json({ success: true, message: `نشانی ${out.ip} مسدود شد`, ip: out.ip, kicked });
});

router.delete('/unban_ip/:ip', (req, res) => {
    const removed = ban.unbanIp(getDb(), decodeURIComponent(req.params.ip));
    if (!removed) return res.status(404).json({ success: false, message: 'این نشانی در فهرست بن نیست' });
    res.json({ success: true, message: 'نشانی باز شد' });
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
