'use strict';

/** سرورهای بازی شبکهٔ محلی (LAN) */

const express = require('express');
const { getDb, now } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

const HOST_RE = /^[a-zA-Z0-9._-]+$/;

function isValidIp(ip) {
    if (!/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip)) return false;
    return ip.split('.').every(part => Number(part) <= 255);
}

router.get('/lan_hosts', requireAuth, (req, res) => {
    const rows = getDb().all(`
        SELECT h.*, u.full_name, u.username
        FROM lan_hosts h JOIN users u ON u.id = h.user_id
        ORDER BY h.created_at DESC, h.id DESC
    `);
    res.json(rows.map(h => ({
        id: h.id,
        user_id: h.user_id,
        full_name: h.full_name,
        username: h.username,
        game_name: h.game_name,
        ip_address: h.ip_address,
        port: h.port,
        description: h.description || '',
        created_at: h.created_at
    })));
});

router.post('/create_lan_host', requireAuth, (req, res) => {
    const b = req.body || {};
    const game_name = String(b.game_name || '').trim();
    const ip_address = String(b.ip_address || '').trim();
    const port = String(b.port || '').trim();
    const description = String(b.description || '').trim();

    if (!game_name || !ip_address || !port) {
        return res.json({ success: false, message: 'نام بازی، IP و پورت را پر کن' });
    }
    /* اگر شبیه IP است باید IP معتبر باشد، وگرنه نام میزبان */
    const looksLikeIp = /^[0-9.]+$/.test(ip_address);
    if (looksLikeIp ? !isValidIp(ip_address) : !HOST_RE.test(ip_address)) {
        return res.json({ success: false, message: 'آدرس IP یا نام میزبان معتبر نیست' });
    }
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        return res.json({ success: false, message: 'پورت باید عددی بین ۱ تا ۶۵۵۳۵ باشد' });
    }
    if (game_name.length > 60) return res.json({ success: false, message: 'نام بازی خیلی بلند است' });

    const { lastId } = getDb().run(
        'INSERT INTO lan_hosts (user_id, game_name, ip_address, port, description, created_at) VALUES (?,?,?,?,?,?)',
        req.user.id, game_name, ip_address, String(portNum), description.slice(0, 300), now()
    );
    res.json({ success: true, id: lastId });
});

router.delete('/delete_lan_host/:id', requireAuth, (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const host = db.get('SELECT * FROM lan_hosts WHERE id = ?', id);
    if (!host) return res.status(404).json({ success: false, message: 'هاست پیدا نشد' });
    if (host.user_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'فقط سازنده یا مدیر می‌تواند حذف کند' });
    }
    db.run('DELETE FROM lan_hosts WHERE id = ?', id);
    res.json({ success: true });
});

module.exports = router;
