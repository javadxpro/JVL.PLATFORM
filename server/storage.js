'use strict';

/**
 * ذخیره‌سازی آپلودها: multer روی دیسک + نام امن + دسته‌بندی پوشه.
 * سقف‌ها دقیقاً همان LIMITS کلاینت هستند تا پیام خطاها هم‌خوان بمانند.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const Config = require('./config');

const MB = 1024 * 1024;
const TMP = path.join(Config.uploads.root, 'tmp');
fs.mkdirSync(TMP, { recursive: true });

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'avif'];
const VIDEO_EXT = ['mp4', 'mkv', 'mov', 'webm', 'avi', 'flv', '3gp', 'm4v'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'weba', 'opus'];

function extOf(name = '') {
    const m = /\.([a-z0-9]{1,8})$/i.exec(name);
    return m ? m[1].toLowerCase() : '';
}

/** دستهٔ فایل بر پایهٔ نام و نوع MIME (هم‌راستا با fileKind در کلاینت) */
function kindOf(originalName, mimetype) {
    const ext = extOf(originalName);
    const type = (mimetype || '').toLowerCase();
    if (IMAGE_EXT.includes(ext) || type.startsWith('image/')) return 'image';
    if (VIDEO_EXT.includes(ext) || type.startsWith('video/')) return 'video';
    if (AUDIO_EXT.includes(ext) || type.startsWith('audio/')) return 'audio';
    return 'file';
}

/** سقف مجاز بر حسب دسته */
function limitFor(kind) {
    if (kind === 'image') return Config.limits.image;
    if (kind === 'video') return Config.limits.video;
    return Config.limits.file;
}

const safeExt = ext => (/^[a-z0-9]{1,8}$/.test(ext) ? ext : 'bin');

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, TMP),
        filename: (req, file, cb) => cb(null, `tmp-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`)
    }),
    limits: { fileSize: Config.limits.file, files: Config.limits.files, fieldSize: Config.limits.field },
    /* فقط یک فایل در هر درخواست؛ فیلدهای متنی بدون محدودیت نوع */
    fileFilter: (req, file, cb) => {
        if (req.__fileSeen) return cb(Object.assign(new Error('فقط یک فایل در هر درخواست'), { code: 'TOO_MANY' }));
        req.__fileSeen = true;
        cb(null, true);
    }
});

/** میدل‌ور تک‌فیلد `file` با تحمل نبودِ فایل */
const uploadOne = upload.single('file');

/**
 * انتقال فایل موقت به پوشهٔ نهایی.
 * اگر فایل بزرگ‌تر از سقف دستهٔ خودش باشد، حذف و خطا برگردانده می‌شود.
 * خروجی: { file_path, file_name, file_type, size } یا { error }
 */
function commit(file, kind) {
    if (!file) return { error: null, file: null };
    const type = kindOf(file.originalname, file.mimetype);
    const size = file.size;
    const limit = limitFor(type);
    if (size > limit) {
        try { fs.unlinkSync(file.path); } catch { /* ignore */ }
        const mb = (limit / MB).toFixed(0);
        return { error: `فایل بزرگ‌تر از ${mb} مگابایت است (${(size / MB).toFixed(2)}MB)` };
    }
    if (!Config.uploadKinds.includes(kind)) return { error: 'دستهٔ نامعتبر فایل' };

    const name = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${safeExt(extOf(file.originalname))}`;
    const dest = path.join(Config.uploads[kind], name);
    try {
        fs.renameSync(file.path, dest);
    } catch {
        try { fs.copyFileSync(file.path, dest); fs.unlinkSync(file.path); } catch (e) { return { error: 'ذخیرهٔ فایل ناموفق بود' }; }
    }
    return { file: { file_path: name, file_name: file.originalname || name, file_type: type, size } };
}

function removeFile(kind, filename) {
    if (!filename || !Config.uploadKinds.includes(kind)) return false;
    const p = path.join(Config.uploads[kind], path.basename(String(filename)));
    try { fs.unlinkSync(p); return true; } catch { return false; }
}

/** تبدیل خطاهای multer به پاسخ JSON خوانا */
function multerErrorHandler(err, req, res, next) {
    if (!err || !(err instanceof multer.MulterError || err.code === 'TOO_MANY' || err.name === 'MulterError')) return next(err);
    let message = 'خطا در دریافت فایل';
    if (err.code === 'LIMIT_FILE_SIZE') message = `حجم فایل بیش از ${(Config.limits.file / MB).toFixed(0)} مگابایت است`;
    else if (err.code === 'TOO_MANY' || err.code === 'LIMIT_UNEXPECTED_FILE') message = 'فقط یک فایل در هر درخواست مجاز است';
    else if (err.code === 'LIMIT_FIELD_VALUE') message = 'مقدار فیلد خیلی بزرگ است';
    return res.status(400).json({ success: false, message });
}

module.exports = { uploadOne, commit, removeFile, multerErrorHandler };
