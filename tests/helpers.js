'use strict';

/**
 * هلپر تست: یک سرور کامل (HTTP + Socket.IO) روی پورت تصادفی با دیتابیس در حافظه.
 * همهٔ کلاینت‌های تست به همان یک سرور وصل می‌شوند (دیتابیس مشترک).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

/* پیش از هر require دیگری: دیتادایر ایزوله برای تست */
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jvl-test-'));
process.env.JVL_DATA_DIR = TEST_DATA_DIR;
process.env.JVL_DB = path.join(TEST_DATA_DIR, 'test.db');
process.env.JVL_SECRET = 'test-secret';
process.env.JVL_QUIET = '1';

const Config = require('../server/config');
const { Db } = require('../server/db');
const { createApp } = require('../server/app');
const rt = require('../server/realtime');

/** یک PNG یک‌پیکسلی معتبر برای تست آپلود */
const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
);

function makeClient(base, token = null) {
    const c = {
        base,
        token,
        user: null,
        async req(method, url, { body, headers, form } = {}) {
            const opts = { method, headers: { ...(headers || {}) } };
            if (c.token) opts.headers.Authorization = `Bearer ${c.token}`;
            if (form) opts.body = form;
            else if (body !== undefined) {
                opts.headers['Content-Type'] = 'application/json';
                opts.body = JSON.stringify(body);
            }
            const res = await fetch(base + url, opts);
            let json = null;
            try { json = await res.json(); } catch { /* پاسخ غیر JSON */ }
            return { status: res.status, body: json, res };
        },
        get(url, o) { return c.req('GET', url, o); },
        post(url, body, o) { return c.req('POST', url, { body, ...(o || {}) }); },
        del(url, o) { return c.req('DELETE', url, o); },
        upload(url, fields, fileName, buffer, mimeType = 'image/png') {
            const form = new FormData();
            for (const [k, v] of Object.entries(fields || {})) {
                if (v !== undefined && v !== null) form.append(k, String(v));
            }
            if (fileName) form.append('file', new Blob([buffer], { type: mimeType }), fileName);
            return c.req('POST', url, { form });
        },
        async register(username, password) {
            const r = await c.post('/register', { username, password });
            return r.body;
        },
        async login(username, password) {
            const r = await c.post('/login', { username, password });
            if (r.body && r.body.token) { c.token = r.body.token; c.user = r.body.user; }
            return r;
        }
    };
    return c;
}

async function startTestServer() {
    const db = new Db(':memory:').migrate();
    const app = createApp({ db });
    const server = http.createServer(app);
    const io = rt.attach(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    return {
        base,
        server,
        db,
        io,
        client(token) { return makeClient(base, token); },
        async close() {
            rt.reset();
            await new Promise(resolve => server.close(resolve));
            try { db.close(); } catch { /* ignore */ }
        }
    };
}

module.exports = { startTestServer, makeClient, PNG_1PX, TEST_DATA_DIR, Config };
