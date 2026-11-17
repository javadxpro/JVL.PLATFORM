#!/usr/bin/env node
'use strict';

/**
 * ابزار خط فرمان JVL.PLATFORM
 *
 *   node server/cli.js start [--port 3000] [--host 0.0.0.0]
 *   node server/cli.js create-admin <username> [password]
 *   node server/cli.js promote <username> | demote <username>
 *   node server/cli.js list-users
 *   node server/cli.js stats
 *   node server/cli.js doctor        ← بررسی سازگاری نسخهٔ صفحه با سرور و دارایی‌ها
 *   node server/cli.js reset --yes   ← پاک‌کردن کامل داده‌ها
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const Config = require('./config');
const { Db, getDb, closeDb, now } = require('./db');
const { makePasswordRecord } = require('./auth');

function flags(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
            else out[key] = true;
        } else out._.push(a);
    }
    return out;
}

function fail(msg, code = 1) {
    console.error(`✖ ${msg}`);
    closeDb();
    process.exit(code);
}

function ok(msg) { console.log(`✔ ${msg}`); }

/* ───────── دستورهای دیتابیس ───────── */

function createUser(username, password, role) {
    const db = getDb();
    if (db.get('SELECT id FROM users WHERE username = ?', username)) {
        fail(`کاربر «${username}» از قبل وجود دارد`);
    }
    const { lastId } = db.run(
        'INSERT INTO users (username, password_hash, full_name, bio, avatar, role, created_at) VALUES (?,?,?,?,NULL,?,?)',
        username, makePasswordRecord(password), username, '', role, now()
    );
    return db.get('SELECT id, username, role, created_at FROM users WHERE id = ?', lastId);
}

function findUser(username) {
    const u = getDb().get('SELECT * FROM users WHERE username = ?', username);
    if (!u) fail(`کاربر «${username}» پیدا نشد`);
    return u;
}

/* ───────── doctor ───────── */

function readClientVersion() {
    try {
        const html = fs.readFileSync(Config.indexHtml, 'utf8');
        const m = /const\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(html);
        return m ? m[1] : null;
    } catch { return null; }
}

function doctor() {
    let problems = 0;
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    console.log(`نود: ${process.version} ${nodeMajor >= 22 ? '✔' : '✖ (>=22.5 لازم است)'}`);
    if (nodeMajor < 22) problems++;

    for (const mod of ['express', 'socket.io', 'socket.io-client', 'multer', 'vazirmatn']) {
        try {
            const pkg = require(`${mod}/package.json`);
            console.log(`وابستگی ${mod}: ${pkg.version} ✔`);
        } catch {
            console.log(`وابستگی ${mod}: نصب نیست ✖ (npm install)`);
            problems++;
        }
    }

    const meta = require('./routes/meta');
    console.log(`کلاینت سوکت: ${fs.existsSync(meta.SOCKET_IO_CLIENT) ? meta.SOCKET_IO_CLIENT + ' ✔' : 'یافت نشد ✖'}`);
    if (!fs.existsSync(meta.SOCKET_IO_CLIENT)) problems++;

    const font = path.join(meta.FONTS_DIR, 'Vazirmatn-Regular.woff2');
    console.log(`فونت وزیرمتن: ${fs.existsSync(font) ? '✔' : '✖ یافت نشد'}`);
    if (!fs.existsSync(font)) problems++;

    const clientVersion = readClientVersion();
    console.log(`نسخهٔ index.html: ${clientVersion || 'نامشخص'} | نسخهٔ سرور: ${Config.app_version}`);
    if (clientVersion !== Config.app_version) {
        console.log('✖ نسخهٔ صفحه و سرور یکی نیست — Config.app_version را در server/config.js همگام کن');
        problems++;
    }

    console.log(problems ? `\n${problems} مشکل پیدا شد` : '\nهمه‌چیز آماده است ✅');
    closeDb();
    process.exit(problems ? 1 : 0);
}

/* ───────── main ───────── */

function main() {
    const args = flags(process.argv.slice(2));
    const cmd = (args._[0] || 'help').toLowerCase();

    switch (cmd) {
        case 'start': {
            const { startServer } = require('./index');
            startServer({ port: args.port ? Number(args.port) : undefined, host: args.host });
            break;
        }
        case 'create-admin':
        case 'create-user': {
            const username = args._[1];
            if (!username) fail('نام کاربری لازم است: cli.js create-admin <username> [password]');
            const generated = !args._[2];
            const password = args._[2] || crypto.randomBytes(6).toString('base64url');
            const role = cmd === 'create-admin' ? 'admin' : 'user';
            const u = createUser(username, password, role);
            ok(`کاربر #${u.id} «${u.username}» با نقش ${u.role} ساخته شد`);
            if (generated) console.log(`  رمز تصادفی: ${password}`);
            closeDb();
            break;
        }
        case 'promote':
        case 'demote': {
            const username = args._[1];
            if (!username) fail('نام کاربری لازم است');
            const u = findUser(username);
            getDb().run('UPDATE users SET role = ? WHERE id = ?', cmd === 'promote' ? 'admin' : 'user', u.id);
            ok(`«${username}» اکنون ${cmd === 'promote' ? 'مدیر 👑' : 'کاربر عادی'} است`);
            closeDb();
            break;
        }
        case 'list-users': {
            const rows = getDb().all('SELECT id, username, full_name, role, created_at, last_seen_at FROM users ORDER BY id');
            if (!rows.length) console.log('هنوز کاربری ثبت‌نام نکرده.');
            for (const u of rows) {
                console.log(`#${String(u.id).padStart(3)}  ${u.username.padEnd(20)} ${u.full_name.padEnd(20)} ${u.role.padEnd(6)} عضو: ${u.created_at}`);
            }
            closeDb();
            break;
        }
        case 'stats': {
            const db = getDb();
            const stats = {
                users: db.count('SELECT 1 FROM users'),
                groups: db.count('SELECT 1 FROM groups'),
                messages: db.count('SELECT 1 FROM messages'),
                posts: db.count('SELECT 1 FROM posts'),
                likes: db.count('SELECT 1 FROM post_likes'),
                comments: db.count('SELECT 1 FROM post_comments'),
                follows: db.count('SELECT 1 FROM follows'),
                stories: db.count('SELECT 1 FROM stories WHERE expires_at > ?', now()),
                lan_hosts: db.count('SELECT 1 FROM lan_hosts')
            };
            if (args.json) {
                /* خروجی ماشین‌خوان: فقط JSON */
                console.log(JSON.stringify({ ...stats, db_file: Config.dbFile }, null, 2));
            } else {
                for (const [k, v] of Object.entries(stats)) console.log(`${k.padEnd(12)} ${v}`);
                console.log(`db           ${Config.dbFile}`);
            }
            closeDb();
            break;
        }
        case 'reset': {
            if (args.yes !== true) fail('برای اطمینان «--yes» را اضافه کن (همه داده‌ها پاک می‌شود)');
            closeDb();
            for (const f of [Config.dbFile, `${Config.dbFile}-wal`, `${Config.dbFile}-shm`]) {
                try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
            }
            for (const kind of Config.uploadKinds) {
                const dir = Config.uploads[kind];
                for (const f of fs.readdirSync(dir)) {
                    try { fs.rmSync(path.join(dir, f), { recursive: true, force: true }); } catch { /* ignore */ }
                }
            }
            new Db(Config.dbFile).migrate().close();
            ok('دیتابیس و فایل‌های آپلود پاک و از نو ساخته شد');
            break;
        }
        case 'doctor':
            doctor();
            break;
        case 'version':
        case '-v':
        case '--version':
            console.log(`${Config.app_name} ${Config.app_version} (node ${process.version})`);
            break;
        default:
            console.log(`JVL.PLATFORM v${Config.app_version}

دستورها:
  start [--port N] [--host H]        اجرای سرور
  create-admin <user> [pass]         ساخت مدیر (بدون رمز → رمز تصادفی)
  create-user <user> [pass]          ساخت کاربر عادی
  promote <user> | demote <user>     تغییر نقش
  list-users                         فهرست کاربران
  stats [--json]                     آمار دیتابیس
  doctor                             بررسی سلامت نصب و همگامی نسخه
  reset --yes                        پاک‌کردن کامل داده‌ها
  version                            نمایش نسخه

متغیرهای محیطی: PORT, HOST, JVL_DATA_DIR, JVL_DB, JVL_SECRET, JVL_QUIET`);
    }
}

if (require.main === module) {
    try { main(); } catch (e) { fail(e && e.message ? e.message : String(e)); }
}

module.exports = { main, readClientVersion };
