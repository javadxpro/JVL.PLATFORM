'use strict';

/** پروفایل خود کاربر: ویرایش اطلاعات و تغییر رمز */

const express = require('express');
const { getDb } = require('../db');
const { requireAuth, makePasswordRecord, checkPassword, publicUser } = require('../auth');
const { uploadOne, commit, removeFile, multerErrorHandler } = require('../storage');

const router = express.Router();

router.post('/update_profile', requireAuth, uploadOne, multerErrorHandler, (req, res) => {
    const db = getDb();
    const me = req.user.id;
    const fullName = String((req.body && req.body.full_name) || '').trim();
    const bio = String((req.body && req.body.bio) || '').trim();

    if (!fullName) return res.json({ success: false, message: 'نام نمایشی را بنویس' });
    if (fullName.length > 60) return res.json({ success: false, message: 'نام نمایشی خیلی بلند است' });
    if (bio.length > 300) return res.json({ success: false, message: 'بیوگرافی خیلی بلند است' });

    let avatar = req.user.avatar || null;
    if (req.file) {
        const out = commit(req.file, 'profiles');
        if (out.error) return res.json({ success: false, message: out.error });
        if (out.file.file_type !== 'image') {
            removeFile('profiles', out.file.file_path);
            return res.json({ success: false, message: 'فایل پروفایل باید عکس باشد' });
        }
        const old = req.user.avatar;
        avatar = out.file.file_path;
        if (old && old !== avatar) removeFile('profiles', old);
    }

    db.run('UPDATE users SET full_name = ?, bio = ?, avatar = ? WHERE id = ?', fullName, bio, avatar, me);
    res.json({ success: true, user: publicUser(db.get('SELECT * FROM users WHERE id = ?', me)) });
});

router.post('/change_password', requireAuth, (req, res) => {
    const db = getDb();
    const oldPassword = String((req.body && req.body.old_password) || '');
    const newPassword = String((req.body && req.body.new_password) || '');
    const user = db.get('SELECT * FROM users WHERE id = ?', req.user.id);

    if (!checkPassword(oldPassword, user.password_hash)) {
        return res.json({ success: false, message: 'رمز فعلی اشتباه است' });
    }
    if (newPassword.length < 4) return res.json({ success: false, message: 'رمز جدید حداقل ۴ کاراکتر باشد' });

    db.run('UPDATE users SET password_hash = ? WHERE id = ?', makePasswordRecord(newPassword), user.id);
    res.json({ success: true, message: 'رمز عوض شد' });
});

module.exports = router;
