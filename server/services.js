'use strict';

/**
 * سرویس‌های مشترک: سریال‌سازی ردیف‌ها به همان شکلی که index.html مصرف می‌کند،
 * به‌علاوهٔ انتشار رویدادها و ساخت اعلان‌ها.
 */

const { getDb, now } = require('./db');
const rt = require('./realtime');
const { removeFile } = require('./storage');

/* ───────── پیام ───────── */

const MSG_SELECT = `
    SELECT m.*,
           s.full_name   AS sender_name,
           s.username    AS sender_username,
           r.content     AS reply_content,
           r.file_name   AS reply_file_name,
           rs.full_name  AS reply_sender_name
    FROM messages m
    JOIN users s          ON s.id = m.sender_id
    LEFT JOIN messages r  ON r.id = m.reply_to_id
    LEFT JOIN users rs    ON rs.id = r.sender_id
`;

function serializeMessage(row) {
    if (!row) return null;
    return {
        id: row.id,
        sender_id: row.sender_id,
        sender_name: row.sender_name,
        sender_username: row.sender_username,
        receiver_id: row.receiver_id,
        group_id: row.group_id,
        content: row.content || '',
        file_path: row.file_path,
        file_name: row.file_name,
        file_type: row.file_type,
        reply_to_id: row.reply_to_id,
        reply_content: row.reply_content || '',
        reply_file_name: row.reply_file_name || '',
        reply_sender_name: row.reply_sender_name || '',
        pinned: !!row.pinned,
        forwarded: !!row.forwarded,
        seen: !!row.seen,
        edited_at: row.edited_at,
        timestamp: row.timestamp
    };
}

function getMessage(id) {
    return serializeMessage(getDb().get(`${MSG_SELECT} WHERE m.id = ?`, id));
}

/** شرکت‌کنندگان یک گفتگو (برای انتشار رویداد) */
function participantsOf(msg) {
    const db = getDb();
    if (!msg) return [];
    if (msg.group_id) {
        return db.all('SELECT user_id FROM group_members WHERE group_id = ?', msg.group_id).map(r => r.user_id);
    }
    return [msg.sender_id, msg.receiver_id].filter(Boolean);
}

/** انتشار رویداد به همهٔ طرفین یک گفتگو (گروهی یا دونفره) */
function emitToConversation(msg, event, payload) {
    if (!msg) return;
    rt.emitTo(participantsOf(msg), event, payload);
}

function deleteMessageRow(id) {
    const db = getDb();
    const msg = getMessage(id);
    if (!msg) return null;
    db.run('UPDATE messages SET reply_to_id = NULL WHERE reply_to_id = ?', id);
    db.run('DELETE FROM messages WHERE id = ?', id);
    if (msg.file_path) removeFile('chat', msg.file_path);
    return msg;
}

/* ───────── کاربر ───────── */

function serializeUser(u) {
    if (!u) return null;
    return {
        id: u.id,
        username: u.username,
        full_name: u.full_name,
        bio: u.bio || '',
        avatar: u.avatar || null,
        role: u.role,
        created_at: u.created_at,
        is_online: rt.isOnline(u.id)
    };
}

/* ───────── پست ───────── */

function serializePost(row, meId) {
    if (!row) return null;
    const db = getDb();
    return {
        id: row.id,
        user_id: row.user_id,
        full_name: row.full_name,
        username: row.username,
        avatar: row.avatar || null,
        content: row.content || '',
        file_path: row.file_path,
        file_name: row.file_name,
        file_type: row.file_type,
        views: Number(row.views || 0),
        timestamp: row.timestamp,
        likes_count: db.count('SELECT 1 FROM post_likes WHERE post_id = ?', row.id),
        comments_count: db.count('SELECT 1 FROM post_comments WHERE post_id = ?', row.id),
        liked_by_me: !!(meId && db.get('SELECT 1 AS x FROM post_likes WHERE post_id = ? AND user_id = ?', row.id, meId)),
        followed_by_me: !!(meId && db.get('SELECT 1 AS x FROM follows WHERE follower_id = ? AND followee_id = ?', meId, row.user_id))
    };
}

function allPosts(meId) {
    const rows = getDb().all(`
        SELECT p.*, u.full_name, u.username, u.avatar
        FROM posts p JOIN users u ON u.id = p.user_id
        ORDER BY p.timestamp DESC, p.id DESC
    `);
    return rows.map(r => serializePost(r, meId));
}

function deletePostRow(id) {
    const db = getDb();
    const p = db.get('SELECT * FROM posts WHERE id = ?', id);
    if (!p) return null;
    db.run('DELETE FROM posts WHERE id = ?', id);
    if (p.file_path) removeFile('posts', p.file_path);
    return p;
}

/* ───────── استوری ───────── */

function activeStories(meId) {
    const rows = getDb().all(`
        SELECT st.*, u.full_name, u.username, u.avatar
        FROM stories st JOIN users u ON u.id = st.user_id
        WHERE st.expires_at > ?
        ORDER BY st.created_at ASC, st.id ASC
    `, now()).map(r => ({
            id: r.id,
            user_id: r.user_id,
            full_name: r.full_name,
            username: r.username,
            avatar: r.avatar || null,
            file_path: r.file_path,
            file_type: r.file_type,
            created_at: r.created_at,
            expires_at: r.expires_at,
            viewed_by_me: !!(meId && getDb().get('SELECT 1 AS x FROM story_views WHERE story_id = ? AND user_id = ?', r.id, meId))
        }));
    return rows;
}

/** حذف استوری‌های منقضی و فایل‌هایشان */
function pruneStories() {
    const db = getDb();
    const stale = db.all('SELECT * FROM stories WHERE expires_at <= ?', now());
    for (const s of stale) {
        db.run('DELETE FROM stories WHERE id = ?', s.id);
        if (s.file_path) removeFile('stories', s.file_path);
    }
    return stale.length;
}

/* ───────── اعلان ───────── */

function pushNotification(userId, actorId, type, postId = null) {
    if (!userId || userId === actorId) return null;
    const db = getDb();
    /* از انباشته‌شدن اعلان تکراری جلوگیری می‌کند (مثلاً لایک/برداشتن/لایک پشت‌سرهم) */
    const dup = db.get(
        'SELECT id FROM notifications WHERE user_id = ? AND actor_id = ? AND type = ? AND IFNULL(post_id,0) = IFNULL(?,0) AND is_read = 0',
        userId, actorId, type, postId
    );
    if (dup) return dup.id;
    const actor = db.get('SELECT full_name FROM users WHERE id = ?', actorId);
    const { lastId } = db.run(
        'INSERT INTO notifications (user_id, actor_id, type, post_id, is_read, timestamp) VALUES (?,?,?,?,0,?)',
        userId, actorId, type, postId, now()
    );
    rt.emitTo([userId], 'notify', {
        id: lastId,
        user_id: userId,
        actor_id: actorId,
        actor_name: actor ? actor.full_name : 'کاربر',
        type,
        post_id: postId,
        timestamp: now()
    });
    return lastId;
}

module.exports = {
    MSG_SELECT,
    serializeMessage,
    getMessage,
    participantsOf,
    emitToConversation,
    deleteMessageRow,
    serializeUser,
    serializePost,
    allPosts,
    deletePostRow,
    activeStories,
    pruneStories,
    pushNotification
};
