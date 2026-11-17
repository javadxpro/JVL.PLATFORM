'use strict';

/**
 * مسیرهای Web Push: کلید عمومی VAPID، ثبت اشتراک و لغو آن.
 * شکل پاسخ‌ها همان چیزی است که index.html انتظار دارد.
 */

const express = require('express');
const { getDb, now } = require('../db');
const { requireAuth } = require('../auth');
const push = require('../push');

const router = express.Router();

router.get('/push_public_key', (req, res) => {
    try {
        res.json({ success: true, publicKey: push.publicKey() });
    } catch (e) {
        res.status(500).json({ success: false, message: 'ساخت کلید VAPID ناموفق بود' });
    }
});

router.post('/push_subscribe', requireAuth, (req, res) => {
    const db = getDb();
    const b = req.body || {};
    const out = push.saveSubscription(db, req.user.id, {
        endpoint: String(b.endpoint || ''),
        p256dh: String((b.p256dh) || ''),
        auth: String((b.auth) || '')
    });
    if (!out.ok) return res.json({ success: false, message: out.message });
    const count = push.subscriptionsOf(db, req.user.id).length;
    res.json({ success: true, devices: count, at: now() });
});

router.post('/push_unsubscribe', requireAuth, (req, res) => {
    const db = getDb();
    const removed = push.removeSubscription(db, String((req.body && req.body.endpoint) || ''));
    res.json({ success: true, removed, devices: push.subscriptionsOf(db, req.user.id).length });
});

module.exports = router;
