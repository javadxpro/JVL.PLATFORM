'use strict';

/**
 * لایهٔ داده: SQLite داخلی نود (node:sqlite) — بدون وابستگی بومی و بدون کامپایل.
 * همهٔ کوئری‌ها از اینجا رد می‌شوند تا بولین‌ها/undefined به مقدار قابل‌اتصال
 * برای SQLite تبدیل شوند.
 */

const fs = require('node:fs');
const path = require('node:path');

/* نود ۲۲ ماژول SQLite را «آزمایشی» می‌داند و در هر اجرا هشدار چاپ می‌کند.
   برای یک سرور خانگی/شبکهٔ محلی این فقط نویز است، پس همان یک هشدار فیلتر می‌شود. */
const originalEmitWarning = process.emitWarning;
process.emitWarning = function filteredEmitWarning(warning, ...args) {
    const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
    if (/SQLite is an experimental feature/.test(text)) return;
    return originalEmitWarning.call(process, warning, ...args);
};

const { DatabaseSync } = require('node:sqlite');
const Config = require('./config');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    full_name     TEXT    NOT NULL,
    bio           TEXT    DEFAULT '',
    avatar        TEXT    DEFAULT NULL,
    role          TEXT    NOT NULL DEFAULT 'user',
    created_at    TEXT    NOT NULL,
    last_seen_at  TEXT    DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    group_id    INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    content     TEXT    DEFAULT '',
    file_path   TEXT    DEFAULT NULL,
    file_name   TEXT    DEFAULT NULL,
    file_type   TEXT    DEFAULT NULL,
    reply_to_id INTEGER DEFAULT NULL,
    pinned      INTEGER NOT NULL DEFAULT 0,
    forwarded   INTEGER NOT NULL DEFAULT 0,
    seen        INTEGER NOT NULL DEFAULT 0,
    edited_at   TEXT    DEFAULT NULL,
    timestamp   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_pair  ON messages(sender_id, receiver_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, timestamp);

CREATE TABLE IF NOT EXISTS groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role      TEXT    NOT NULL DEFAULT 'member',
    joined_at TEXT    NOT NULL,
    UNIQUE(group_id, user_id)
);

/* آخرین زمانی که کاربر پیام‌های یک گروه را دیده (برای شمارش خوانده‌نشده‌ها) */
CREATE TABLE IF NOT EXISTS group_reads (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id     INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    last_read_at TEXT    NOT NULL,
    PRIMARY KEY (user_id, group_id)
);

CREATE TABLE IF NOT EXISTS posts (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content   TEXT    DEFAULT '',
    file_path TEXT    DEFAULT NULL,
    file_name TEXT    DEFAULT NULL,
    file_type TEXT    DEFAULT NULL,
    views     INTEGER NOT NULL DEFAULT 0,
    timestamp TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_time ON posts(timestamp);

CREATE TABLE IF NOT EXISTS post_likes (
    post_id   INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    timestamp TEXT    NOT NULL,
    PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS post_comments (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id   INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content   TEXT    NOT NULL,
    timestamp TEXT    NOT NULL
);

/* تاریخچهٔ تماشای ویدیوها */
CREATE TABLE IF NOT EXISTS post_views (
    post_id   INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at TEXT    NOT NULL,
    PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS stories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_path  TEXT    NOT NULL,
    file_name  TEXT    DEFAULT NULL,
    file_type  TEXT    DEFAULT 'image',
    created_at TEXT    NOT NULL,
    expires_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS story_views (
    story_id  INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at TEXT    NOT NULL,
    PRIMARY KEY (story_id, user_id)
);

CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    timestamp   TEXT    NOT NULL,
    PRIMARY KEY (follower_id, followee_id)
);

CREATE TABLE IF NOT EXISTS notifications (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type      TEXT    NOT NULL,               /* like | comment | follow */
    post_id   INTEGER DEFAULT NULL,
    is_read   INTEGER NOT NULL DEFAULT 0,
    timestamp TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, timestamp);

CREATE TABLE IF NOT EXISTS lan_hosts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_name   TEXT    NOT NULL,
    ip_address  TEXT    NOT NULL,
    port        TEXT    NOT NULL,
    description TEXT    DEFAULT '',
    created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    bio         TEXT    DEFAULT '',
    avatar      TEXT    DEFAULT NULL,
    owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_public   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_subs (
    channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at   TEXT    NOT NULL,
    PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS channel_posts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content     TEXT    DEFAULT '',
    file_path   TEXT    DEFAULT NULL,
    file_name   TEXT    DEFAULT NULL,
    file_type   TEXT    DEFAULT NULL,
    created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_post_views (
    post_id     INTEGER NOT NULL REFERENCES channel_posts(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at   TEXT    NOT NULL,
    PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS channel_comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id     INTEGER NOT NULL REFERENCES channel_posts(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content     TEXT    NOT NULL,
    created_at  TEXT    NOT NULL
);
`;

/* ───────── ابزار زمان ───────── */

function pad(n) { return String(n).padStart(2, '0'); }

/** زمان محلی به قالب «YYYY-MM-DD HH:MM:SS» (کلاینت با replace(' ','T') می‌خواندش) */
function now(date = new Date()) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function plusHours(hours, from = new Date()) {
    return now(new Date(from.getTime() + hours * 3600 * 1000));
}

/* ───────── اتصال ───────── */

/** نرمال‌سازی پارامترها برای SQLite نود (بولین/undefined مجاز نیستند) */
function bind(values) {
    return values.map(v => {
        if (v === undefined || v === null) return null;
        if (typeof v === 'boolean') return v ? 1 : 0;
        if (typeof v === 'number' || typeof v === 'bigint' || v instanceof Uint8Array) return v;
        return String(v);
    });
}

class Db {
    constructor(file) {
        if (file && file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
        this.file = file;
        this.db = new DatabaseSync(file);
        this.db.exec('PRAGMA foreign_keys = ON');
    }

    migrate() {
        this.db.exec(SCHEMA);
        /* WAL روی حافظه معنا ندارد؛ بی‌صدا رد می‌شود */
        return this;
    }

    exec(sql) { return this.db.exec(sql); }

    run(sql, ...values) {
        const r = this.db.prepare(sql).run(...bind(values));
        return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
    }

    get(sql, ...values) {
        const row = this.db.prepare(sql).get(...bind(values));
        return row === undefined ? null : row;
    }

    all(sql, ...values) {
        return this.db.prepare(sql).all(...bind(values));
    }

    count(sql, ...values) {
        const row = this.get(`SELECT COUNT(*) AS n FROM (${sql})`, ...values);
        return Number(row ? row.n : 0);
    }

    /** اجرای چند عملیات به‌صورت اتمیک */
    transaction(fn) {
        this.db.exec('BEGIN');
        try {
            const out = fn();
            this.db.exec('COMMIT');
            return out;
        } catch (err) {
            try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
            throw err;
        }
    }

    close() { try { this.db.close(); } catch { /* ignore */ } }
}

let shared = null;

/** اتصال مشترک برنامه (در تست‌ها با Db(':memory:') جایگزین می‌شود) */
function getDb() {
    if (!shared) shared = new Db(Config.dbFile).migrate();
    return shared;
}

function setDb(db) { shared = db; }

function closeDb() {
    if (shared) { shared.close(); shared = null; }
}

module.exports = { Db, getDb, setDb, closeDb, now, plusHours };
