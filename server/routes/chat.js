'use strict';

/** چت: پیام‌های دونفره و گروهی، دیده‌شدن، سنجاق، ویرایش، هدایت و حذف */

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const Config = require('../config');
const { getDb, now } = require('../db');
const { requireAuth } = require('../auth');
const {
    MSG_SELECT, getMessage, serializeMessage, participantsOf,
    emitToConversation, deleteMessageRow
} = require('../services');
const { uploadOne, commit, multerErrorHandler } = require('../storage');
const rt = require('../realtime');

const router = express.Router();

/* ───────── خواندن ───────── */

router.get('/messages/:me/:peer', requireAuth, (req, res) => {
    const me = req.user.id;
    const peer = Number(req.params.peer);
    if (!peer) return res.json([]);
    const rows = getDb().all(
        `${MSG_SELECT}
         WHERE m.group_id IS NULL
           AND ((m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?))
         ORDER BY m.timestamp ASC, m.id ASC`,
        me, peer, peer, me
    );
    res.json(rows.map(serializeMessage));
});

router.get('/group_messages/:gid', requireAuth, (req, res) => {
    const db = getDb();
    const gid = Number(req.params.gid);
    const member = db.get('SELECT 1 AS x FROM group_members WHERE group_id = ? AND user_id = ?', gid, req.user.id);
    if (!member && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'عضو این گروه نیستی' });
    }
    const rows = db.all(`${MSG_SELECT} WHERE m.group_id = ? ORDER BY m.timestamp ASC, m.id ASC`, gid);
    /* بازکردن گفتگو = خوانده‌شدن پیام‌های گروه */
    db.run(
        `INSERT INTO group_reads (user_id, group_id, last_read_at) VALUES (?,?,?)
         ON CONFLICT(user_id, group_id) DO UPDATE SET last_read_at = excluded.last_read_at`,
        req.user.id, gid, now()
    );
    res.json(rows.map(serializeMessage));
});

/* ───────── ارسال ───────── */

function insertMessage({ sender_id, receiver_id, group_id, content, file, reply_to_id, forwarded }) {
    const db = getDb();
    const { lastId } = db.run(
        `INSERT INTO messages
            (sender_id, receiver_id, group_id, content, file_path, file_name, file_type, reply_to_id, forwarded, seen, timestamp)
         VALUES (?,?,?,?,?,?,?,?,?,0,?)`,
        sender_id,
        receiver_id || null,
        group_id || null,
        content || '',
        file ? file.file_path : null,
        file ? file.file_name : null,
        file ? file.file_type : null,
        reply_to_id || null,
        forwarded ? 1 : 0,
        now()
    );
    return getMessage(lastId);
}

router.post('/send_message', requireAuth, uploadOne, multerErrorHandler, (req, res) => {
    const db = getDb();
    const me = req.user.id;
    const content = String((req.body && req.body.content) || '').trim();
    const groupId = req.body && req.body.group_id ? Number(req.body.group_id) : null;
    const receiverId = req.body && req.body.receiver_id ? Number(req.body.receiver_id) : null;
    const replyToId = req.body && req.body.reply_to_id ? Number(req.body.reply_to_id) : null;

    let file = null;
    if (req.file) {
        const out = commit(req.file, 'chat');
        if (out.error) return res.json({ success: false, message: out.error });
        file = out.file;
    }

    if (!content && !file) {
        return res.json({ success: false, message: 'پیام خالی است' });
    }

    if (groupId) {
        const member = db.get('SELECT 1 AS x FROM group_members WHERE group_id = ? AND user_id = ?', groupId, me);
        if (!member) {
            if (file) fs.rmSync(path.join(Config.uploads.chat, file.file_path), { force: true });
            return res.status(403).json({ success: false, message: 'عضو این گروه نیستی' });
        }
    } else if (receiverId) {
        if (receiverId === me) return res.json({ success: false, message: 'نمی‌توانی به خودت پیام بدهی' });
        if (!db.get('SELECT id FROM users WHERE id = ?', receiverId)) {
            return res.status(404).json({ success: false, message: 'گیرنده پیدا نشد' });
        }
    } else {
        if (file) fs.rmSync(path.join(Config.uploads.chat, file.file_path), { force: true });
        return res.json({ success: false, message: 'مقصد پیام مشخص نیست' });
    }

    const reply = replyToId ? getMessage(replyToId) : null;
    const msg = insertMessage({
        sender_id: me,
        receiver_id: groupId ? null : receiverId,
        group_id: groupId,
        content,
        file,
        reply_to_id: reply ? reply.id : null,
        forwarded: false
    });

    emitToConversation(msg, 'new_message', msg);
    notifyOffline(msg, req.user);
    res.json({ success: true, message: msg });
});

/**
 * اعلان Web Push برای گیرنده‌هایی که الان آنلاین نیستند.
 *
 * آنلاین‌ها را عمداً رد می‌کنیم: صفحهٔ بازِ خودشان اعلان را نشان می‌دهد و
 * اعلان سرویس پوش همزمان، تکراری و مزاحم می‌شود.
 *
 * هیچ‌وقت نباید جریان درخواست را معطل یا خراب کند — اگر سرویس پوش در دسترس
 * نبود، پیام همچنان از راه سوکت می‌رسد.
 */
function notifyOffline(msg, actor) {
    try {
        const db = getDb();
        const push = require('../push');
        const body = msg.content
            || (msg.file_type === 'image' ? '\u{1F5BC} تصویر'
            : String(msg.file_type || '').indexOf('audio') === 0 ? '\u{1F399} پیام صوتی'
            : '\u{1F4CE} ' + (msg.file_name || 'پیوست'));
        const senderName = (actor && actor.full_name) || 'پیام جدید';

        if (msg.group_id) {
            const g = db.get('SELECT name FROM groups WHERE id = ?', msg.group_id);
            const rows = db.all('SELECT user_id FROM group_members WHERE group_id = ?', msg.group_id);
            const title = (g ? g.name : 'گروه') + ' \u00B7 ' + senderName;
            for (const r of rows) {
                if (r.user_id === msg.sender_id || rt.isOnline(r.user_id)) continue;
                push.pushTo(db, r.user_id, {
                    title, body, tag: 'dm-g' + msg.group_id,
                    group: msg.group_id, url: 'index.html'
                }).catch(() => {});
            }
            return;
        }
        if (!msg.receiver_id || rt.isOnline(msg.receiver_id)) return;
        push.pushTo(db, msg.receiver_id, {
            title: senderName, body, tag: 'dm-' + msg.sender_id,
            peer: msg.sender_id, url: 'index.html'
        }).catch(() => {});
    } catch { /* پوش اختیاری است */ }
}

/* ───────── دیده‌شدن ───────── */

router.post('/seen_messages/:sender', requireAuth, (req, res) => {
    const db = getDb();
    const me = req.body && req.body.me ? Number(req.body.me) : req.user.id;
    const sender = Number(req.params.sender);
    const { changes } = db.run(
        'UPDATE messages SET seen = 1 WHERE sender_id = ? AND receiver_id = ? AND seen = 0', sender, me
    );
    /*
     * فقط به صاحب پیام‌ها خبر می‌دهیم. اگر به خودِ خواننده هم برود، کلاینت
     * دوباره loadMessages می‌زند و حلقهٔ seen→loadMessages→seen ساخته می‌شود.
     * وقتی هم هیچ پیامی عوض نشده، اصلاً رویدادی نمی‌فرستیم.
     */
    if (changes > 0) rt.emitTo([sender], 'messages_seen', { by: me, partner: sender, count: changes });
    res.json({ success: true, updated: changes });
});

/* ───────── سنجاق ───────── */

router.post('/pin_message/:mid', requireAuth, (req, res) => {
    const db = getDb();
    const mid = Number(req.params.mid);
    const msg = getMessage(mid);
    if (!msg) return res.status(404).json({ success: false, message: 'پیام پیدا نشد' });
    if (!participantsOf(msg).includes(req.user.id) && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'اجازهٔ این کار را نداری' });
    }

    let pinned;
    if (msg.pinned) {
        db.run('UPDATE messages SET pinned = 0 WHERE id = ?', mid);
        pinned = false;
    } else {
        /* فقط یک پیام سنجاق‌شده در هر گفتگو */
        if (msg.group_id) {
            db.run('UPDATE messages SET pinned = 0 WHERE group_id = ?', msg.group_id);
        } else {
            db.run(
                'UPDATE messages SET pinned = 0 WHERE group_id IS NULL AND ((sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?))',
                msg.sender_id, msg.receiver_id, msg.receiver_id, msg.sender_id
            );
        }
        db.run('UPDATE messages SET pinned = 1 WHERE id = ?', mid);
        pinned = true;
    }
    const fresh = getMessage(mid);
    emitToConversation(fresh, 'messages_pin', { message_id: mid, pinned });
    res.json({ success: true, pinned });
});

/* ───────── ویرایش ───────── */

router.post('/edit_message', requireAuth, (req, res) => {
    const db = getDb();
    const mid = Number(req.body && req.body.message_id);
    const content = String((req.body && req.body.content) || '').trim();
    const msg = getMessage(mid);
    if (!msg) return res.status(404).json({ success: false, message: 'پیام پیدا نشد' });
    if (msg.sender_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'فقط نویسندهٔ پیام می‌تواند ویرایش کند' });
    }
    if (!content) return res.json({ success: false, message: 'متن جدید خالی است' });

    db.run('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?', content, now(), mid);
    const fresh = getMessage(mid);
    emitToConversation(fresh, 'message_updated', { message_id: mid });
    res.json({ success: true, message: fresh });
});

/* ───────── حذف ───────── */

router.delete('/delete_message/:mid', requireAuth, (req, res) => {
    const mid = Number(req.params.mid);
    const uid = req.query.uid ? Number(req.query.uid) : req.user.id;
    const msg = getMessage(mid);
    if (!msg) return res.status(404).json({ success: false, message: 'پیام پیدا نشد' });
    if (msg.sender_id !== uid && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'فقط نویسنده یا مدیر می‌تواند حذف کند' });
    }
    deleteMessageRow(mid);
    emitToConversation(msg, 'message_deleted', { message_id: mid });
    res.json({ success: true });
});

/* ───────── هدایت ───────── */

/** کپی فیزیکی فایل تا حذف پیام اصلی، لینت مقصدها را نشکند */
function cloneFile(file) {
    if (!file || !file.file_path) return null;
    const src = path.join(Config.uploads.chat, path.basename(file.file_path));
    if (!fs.existsSync(src)) return null;
    const name = `${Date.now()}-${Math.random().toString(16).slice(2, 12)}${path.extname(file.file_path)}`;
    try {
        fs.copyFileSync(src, path.join(Config.uploads.chat, name));
        return { file_path: name, file_name: file.file_name, file_type: file.file_type };
    } catch {
        return { file_path: file.file_path, file_name: file.file_name, file_type: file.file_type };
    }
}

router.post('/forward_message', requireAuth, (req, res) => {
    const db = getDb();
    const me = req.user.id;
    const mid = Number(req.body && req.body.message_id);
    const targets = Array.isArray(req.body && req.body.targets) ? req.body.targets : [];
    const src = getMessage(mid);
    if (!src) return res.status(404).json({ success: false, message: 'پیام پیدا نشد' });
    if (!participantsOf(src).includes(me) && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'به این پیام دسترسی نداری' });
    }
    if (!targets.length) return res.json({ success: false, message: 'مقصدی انتخاب نشده' });

    let sent = 0;
    for (const t of targets) {
        const type = t && t.type;
        const id = Number(t && t.id);
        if (!id) continue;
        let receiverId = null;
        let groupId = null;

        if (type === 'group') {
            const member = db.get('SELECT 1 AS x FROM group_members WHERE group_id = ? AND user_id = ?', id, me);
            if (!member) continue;
            groupId = id;
        } else {
            if (id === me) continue;
            if (!db.get('SELECT id FROM users WHERE id = ?', id)) continue;
            receiverId = id;
        }

        const copy = insertMessage({
            sender_id: me,
            receiver_id: receiverId,
            group_id: groupId,
            content: src.content,
            file: cloneFile(src),
            reply_to_id: null,
            forwarded: true
        });
        emitToConversation(copy, 'new_message', copy);
        sent += 1;
    }
    res.json({ success: true, sent });
});

module.exports = router;
