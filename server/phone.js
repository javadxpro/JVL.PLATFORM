'use strict';

/**
 * نرمال‌سازی و هش شمارهٔ تلفن.
 *
 * این دو تابع باید **دقیقاً** با `static/js/mqtt-backend.js` یکی باشند، چون
 * یک کاربر ممکن است شماره‌اش را در حالت MQTT ثبت کند و دیگری در حالت سرور
 * دنبالش بگردد. اگر هش‌ها فرق کنند، دو حالت دو دنیای جدا می‌شوند.
 * (تست‌های api و browser هر دو روی همین مقدار ثابت قفل شده‌اند.)
 */

const crypto = require('node:crypto');

/** 0912…، 98912…، 0098912… و ‎+98 912 … همه به 98912… می‌رسند */
function normalizePhone(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (!d) return '';
    if (d.startsWith('00')) d = d.slice(2);
    if (d.length === 11 && d.startsWith('0')) d = '98' + d.slice(1);
    if (d.length === 10 && d.startsWith('9')) d = '98' + d;
    return d;
}

/** هش، تا شمارهٔ خام نه ذخیره شود و نه روی سیم برود */
function phoneHash(raw) {
    const d = normalizePhone(raw);
    if (!d) return '';
    return 'p' + crypto.createHash('sha256').update('jvl-phone:' + d).digest('hex').slice(0, 24);
}

module.exports = { normalizePhone, phoneHash };
