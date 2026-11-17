'use strict';

/** گروه‌ها: ساخت، لیست، اطلاعات، افزودن/حذف عضو و حذف گروه */

const express = require('express');
const Config = require('../config');
const fs = require('node:fs');
const path = require('node:path');
const { getDb, now } = require('../db');
const { requireAuth } = require('../auth');
const { serializeUser } = require('../services');
const rt = require('../realtime');

const router = express.Router();

/** انتشار groups_changed به همهٔ اعضای داده‌شده */
function announceGroupChange(memberIds) {
    rt.emitTo(memberIds, 'groups_changed', { at: Date.now() });
}

function memberIdsOf(gid) {
    return getDb().all('SELECT user_id FROM group_members WHERE group_id = ?', gid).map(r => r.user_id);
}

function isMember(gid, uid) {
    return !!getDb().get('SELECT 1 AS x FROM group_members WHERE group_id = ? AND user_id = ?', gid, uid);
}

function isOwner(gid, uid) {
    const g = getDb().get('SELECT creator_id FROM groups WHERE id = ?', gid);
    return !!g && g.creator_id === uid;
}

/* لیست گروه‌های من + شمار خوانده‌نشده‌ها + آخرین پیام */
router.get('/my_groups', requireAuth, (req, res) => {
    const db = getDb();
    const me = req.user.id;
    const groups = db.all(`
        SELECT g.*, m.role AS my_role
        FROM groups g JOIN group_members m ON m.group_id = g.id
        WHERE m.user_id = ?
        ORDER BY g.created_at DESC, g.id DESC
    `, me);

    const out = groups.map(g => {
        const members_count = db.count('SELECT 1 FROM group_members WHERE group_id = ?', g.id);
        const read = db.get('SELECT last_read_at FROM group_reads WHERE user_id = ? AND group_id = ?', me, g.id);
        const unread = read
            ? db.count('SELECT 1 FROM messages WHERE group_id = ? AND timestamp > ?', g.id, read.last_read_at)
            : db.count('SELECT 1 FROM messages WHERE group_id = ?', g.id);
        const last = db.get('SELECT content, file_name FROM messages WHERE group_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1', g.id);
        return {
            id: g.id,
            name: g.name,
            creator_id: g.creator_id,
            created_at: g.created_at,
            my_role: g.my_role,
            members_count,
            unread,
            last_content: last ? (last.content || '') : '',
            last_file: last ? (last.file_name || '') : ''
        };
    });
    res.json(out);
});

/* ساخت گروه */
router.post('/create_group', requireAuth, (req, res) => {
    const db = getDb();
    const me = req.user.id;
    const name = String((req.body && req.body.name) || '').trim();
    const members = Array.isArray(req.body && req.body.members) ? req.body.members.map(Number).filter(Boolean) : [];

    if (!name) return res.json({ success: false, message: 'نام گروه را بنویس' });
    if (name.length > 60) return res.json({ success: false, message: 'نام گروه خیلی بلند است' });

    const added = db.transaction(() => {
        const { lastId } = db.run('INSERT INTO groups (name, creator_id, created_at) VALUES (?,?,?)', name, me, now());
        db.run('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?,?,?,?)', lastId, me, 'owner', now());
        const valid = new Set();
        for (const uid of members) {
            if (uid === me || valid.has(uid)) continue;
            if (!db.get('SELECT id FROM users WHERE id = ?', uid)) continue;
            db.run('INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at) VALUES (?,?,?,?)', lastId, uid, 'member', now());
            valid.add(uid);
        }
        return { gid: lastId, members: [me, ...valid] };
    });

    announceGroupChange(added.members);
    res.json({ success: true, message: `گروه «${name}» ساخته شد 👥`, group_id: added.gid });
});

/* اطلاعات گروه */
router.get('/group_info/:gid', requireAuth, (req, res) => {
    const db = getDb();
    const gid = Number(req.params.gid);
    const g = db.get('SELECT * FROM groups WHERE id = ?', gid);
    if (!g) return res.status(404).json({ success: false, message: 'گروه پیدا نشد' });
    if (!isMember(gid, req.user.id) && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'عضو این گروه نیستی' });
    }
    const members = db.all(`
        SELECT u.*, gm.role FROM group_members gm JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = ? ORDER BY gm.role DESC, u.full_name COLLATE NOCASE ASC
    `, gid).map(u => ({ ...serializeUser(u), role: u.role }));

    res.json({
        success: true,
        group: { id: g.id, name: g.name, creator_id: g.creator_id, created_at: g.created_at },
        members
    });
});

/* افزودن عضو (مالک یا مدیر) */
router.post('/group_add_member/:gid', requireAuth, (req, res) => {
    const db = getDb();
    const gid = Number(req.params.gid);
    const uid = Number(req.body && req.body.user_id);
    if (!db.get('SELECT id FROM groups WHERE id = ?', gid)) {
        return res.status(404).json({ success: false, message: 'گروه پیدا نشد' });
    }
    if (!isOwner(gid, req.user.id) && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'فقط مالک گروه می‌تواند عضو اضافه کند' });
    }
    if (!db.get('SELECT id FROM users WHERE id = ?', uid)) {
        return res.status(404).json({ success: false, message: 'کاربر پیدا نشد' });
    }
    if (isMember(gid, uid)) return res.json({ success: false, message: 'این کاربر قبلاً عضو است' });

    db.run('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?,?,?,?)', gid, uid, 'member', now());
    announceGroupChange(memberIdsOf(gid));
    res.json({ success: true, message: 'عضو اضافه شد' });
});

/* حذف عضو / خروج از گروه */
router.post('/group_remove_member/:gid', requireAuth, (req, res) => {
    const db = getDb();
    const gid = Number(req.params.gid);
    const uid = Number(req.body && req.body.user_id);
    if (!db.get('SELECT id FROM groups WHERE id = ?', gid)) {
        return res.status(404).json({ success: false, message: 'گروه پیدا نشد' });
    }
    const self = uid === req.user.id;
    if (!self && !isOwner(gid, req.user.id) && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'فقط مالک گروه می‌تواند عضو را حذف کند' });
    }
    if (isOwner(gid, uid) && !self) {
        return res.json({ success: false, message: 'مالک گروه را نمی‌شود حذف کرد' });
    }
    if (!isMember(gid, uid)) return res.json({ success: false, message: 'این کاربر عضو گروه نیست' });

    db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', gid, uid);
    db.run('DELETE FROM group_reads WHERE group_id = ? AND user_id = ?', gid, uid);

    const rest = memberIdsOf(gid);
    if (!rest.length) {
        /* گروه خالی شد؛ خودکار پاک می‌شود */
        const files = db.all('SELECT file_path FROM messages WHERE group_id = ? AND file_path IS NOT NULL', gid);
        for (const f of files) {
            try { fs.rmSync(path.join(Config.uploads.chat, path.basename(f.file_path)), { force: true }); } catch { /* ignore */ }
        }
        db.run('DELETE FROM groups WHERE id = ?', gid);
    } else {
        announceGroupChange([...rest, uid]);
    }
    res.json({ success: true, message: self ? 'از گروه خارج شدی' : 'عضو حذف شد' });
});

/* حذف کامل گروه (مالک یا مدیر) */
router.delete('/group_delete/:gid', requireAuth, (req, res) => {
    const db = getDb();
    const gid = Number(req.params.gid);
    const g = db.get('SELECT * FROM groups WHERE id = ?', gid);
    if (!g) return res.status(404).json({ success: false, message: 'گروه پیدا نشد' });
    if (g.creator_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'فقط مالک گروه یا مدیر می‌تواند حذف کند' });
    }
    const members = memberIdsOf(gid);
    const files = db.all('SELECT file_path FROM messages WHERE group_id = ? AND file_path IS NOT NULL', gid);
    db.run('DELETE FROM groups WHERE id = ?', gid);   /* اعضای گروه و پیام‌ها با CASCADE پاک می‌شوند */
    for (const f of files) {
        try { fs.rmSync(path.join(Config.uploads.chat, path.basename(f.file_path)), { force: true }); } catch { /* ignore */ }
    }
    announceGroupChange(members);
    res.json({ success: true, message: 'گروه حذف شد' });
});

module.exports = router;
