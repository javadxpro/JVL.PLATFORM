'use strict';

/**
 * تست سرتاسری API — دقیقاً همان مسیرهایی که index.html صدا می‌زند.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startTestServer, PNG_1PX, Config } = require('./helpers');

let srv;
let alice;   /* اولین کاربر → مدیر */
let bob;
let eve;     /* کاربر عادی برای تست ۴۰۳ */

test.before(async () => {
    srv = await startTestServer();
    alice = srv.client();
    bob = srv.client();
    eve = srv.client();
});

/* ───────── متا و احراز هویت ───────── */

test('app_info نسخهٔ همگام با index.html را برمی‌گرداند', async () => {
    const r = await alice.get('/api/app_info');
    assert.equal(r.status, 200);
    assert.equal(r.body.version, Config.app_version);
    const html = fs.readFileSync(Config.indexHtml, 'utf8');
    assert.match(html, new RegExp(`const APP_VERSION = '${Config.app_version}'`));
});

test('مسیر ناشناختهٔ API پاسخ JSON ۴۰۴ می‌دهد', async () => {
    const r = await alice.get('/api/nope');
    assert.equal(r.status, 404);
    assert.equal(r.body.success, false);
});

test('بدون توکن، مسیرهای محافظت‌شده ۴۰۱ می‌دهند', async () => {
    const r = await alice.get('/users');
    assert.equal(r.status, 401);
});

test('ثبت‌نام اولین کاربر → مدیر؛ ورود با رمز اشتباه رد می‌شود', async () => {
    const reg = await alice.register('alice', 'pass1234');
    assert.equal(reg.success, true);
    assert.equal(reg.user.role, 'admin');

    const dup = await alice.register('alice', 'pass1234');
    assert.equal(dup.success, false);

    const bad = await alice.login('alice', 'wrong');
    assert.equal(bad.status, 401);

    const okLogin = await alice.login('alice', 'pass1234');
    assert.equal(okLogin.status, 200);
    assert.ok(okLogin.body.token, 'باید توکن بدهد');
    assert.equal(okLogin.body.user.username, 'alice');
});

test('ساخت کاربر دوم و سوم', async () => {
    assert.equal((await bob.register('bob', 'pass1234')).success, true);
    assert.equal((await bob.login('bob', 'pass1234')).status, 200);
    assert.equal(bob.user.role, 'user');

    assert.equal((await eve.register('eve', 'pass1234')).success, true);
    assert.equal((await eve.login('eve', 'pass1234')).status, 200);
});

test('/users همه را با is_online برمی‌گرداند', async () => {
    const r = await alice.get('/users');
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 3);
    for (const u of r.body) {
        assert.equal(typeof u.is_online, 'boolean');
        assert.ok(u.id && u.username && u.full_name);
    }
});

/* ───────── چت دونفره ───────── */

let msgId;

test('ارسال پیام متنی و رسیدن آن به گیرنده', async () => {
    const sent = await alice.upload('/send_message', { content: 'سلام بابک 👋', receiver_id: bob.user.id }, null);
    assert.equal(sent.body.success, true);
    msgId = sent.body.message.id;
    assert.equal(sent.body.message.content, 'سلام بابک 👋');
    assert.equal(sent.body.message.seen, false);

    const list = await bob.get(`/messages/${bob.user.id}/${alice.user.id}`);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].id, msgId);
    assert.equal(list.body[0].sender_name, 'alice');

    const counts = await bob.get(`/unread_counts/${bob.user.id}`);
    assert.equal(counts.body[alice.user.id], 1);
});

test('خوانده‌شدن پیام‌ها شمارش را صفر می‌کند', async () => {
    const seen = await bob.post(`/seen_messages/${alice.user.id}`, { me: bob.user.id });
    assert.equal(seen.body.success, true);
    assert.equal(seen.body.updated, 1);
    const counts = await bob.get(`/unread_counts/${bob.user.id}`);
    assert.equal(counts.body[alice.user.id] || 0, 0);
});

test('ویرایش پیام فقط توسط نویسنده', async () => {
    const byOther = await bob.post('/edit_message', { message_id: msgId, user_id: bob.user.id, content: 'هک' });
    assert.equal(byOther.status, 403);

    const r = await alice.post('/edit_message', { message_id: msgId, user_id: alice.user.id, content: 'سلام بابک (ویرایش‌شده)' });
    assert.equal(r.body.success, true);
    assert.equal(r.body.message.content, 'سلام بابک (ویرایش‌شده)');
    assert.ok(r.body.message.edited_at);
});

test('سنجاق کردن و برداشتن سنجاق', async () => {
    const pin = await alice.post(`/pin_message/${msgId}`, { user_id: alice.user.id });
    assert.equal(pin.body.pinned, true);
    let list = await alice.get(`/messages/${alice.user.id}/${bob.user.id}`);
    assert.equal(list.body.filter(m => m.pinned).length, 1);

    const unpin = await alice.post(`/pin_message/${msgId}`, { user_id: alice.user.id });
    assert.equal(unpin.body.pinned, false);
    list = await alice.get(`/messages/${alice.user.id}/${bob.user.id}`);
    assert.equal(list.body.filter(m => m.pinned).length, 0);
});

test('هدایت پیام به کاربر دیگر', async () => {
    const r = await alice.post('/forward_message', { message_id: msgId, targets: [{ type: 'user', id: eve.user.id }] });
    assert.equal(r.body.success, true);
    assert.equal(r.body.sent, 1);
    const list = await eve.get(`/messages/${eve.user.id}/${alice.user.id}`);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].forwarded, true);
});

test('حذف پیام توسط نویسنده', async () => {
    const r = await alice.del(`/delete_message/${msgId}?uid=${alice.user.id}`);
    assert.equal(r.body.success, true);
    assert.equal((await alice.get(`/messages/${alice.user.id}/${bob.user.id}`)).body.length, 0);
});

/* ───────── فایل چت ───────── */

test('آپلود فایل در چت و سرو شدن از /files/chat', async () => {
    const r = await alice.upload('/send_message', { content: '', receiver_id: bob.user.id }, 'pic.png', PNG_1PX);
    assert.equal(r.body.success, true);
    const msg = r.body.message;
    assert.equal(msg.file_type, 'image');
    assert.equal(msg.file_name, 'pic.png');
    assert.equal((await alice.get(`/files/chat/${encodeURIComponent(msg.file_path)}`)).status, 200);
});

test('فایل بزرگ‌تر از سقف عکس رد می‌شود', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 7);
    const r = await alice.upload('/send_message', { content: '', receiver_id: bob.user.id }, 'big.png', big);
    assert.equal(r.body.success, false);
    assert.match(r.body.message, /مگابایت/);
});

test('پیام خالی (بدون متن و فایل) رد می‌شود', async () => {
    const r = await alice.upload('/send_message', { content: '   ', receiver_id: bob.user.id }, null);
    assert.equal(r.body.success, false);
});

/* ───────── گروه‌ها ───────── */

let groupId;

test('ساخت گروه و فهرست گروه‌های من', async () => {
    const r = await alice.post('/create_group', { name: 'تیم سرور', members: [bob.user.id] });
    assert.equal(r.body.success, true);
    groupId = r.body.group_id;

    const mine = await alice.get('/my_groups');
    assert.equal(mine.body.length, 1);
    assert.equal(mine.body[0].members_count, 2);
    assert.equal(mine.body[0].unread, 0);
    assert.equal((await bob.get('/my_groups')).body.length, 1);
});

test('پیام گروهی می‌رسد و خوانده‌نشده شمرده می‌شود', async () => {
    const sent = await alice.upload('/send_message', { content: 'سلام گروه', group_id: groupId }, null);
    assert.equal(sent.body.success, true);

    assert.equal((await bob.get('/my_groups')).body[0].unread, 1);
    const msgs = await bob.get(`/group_messages/${groupId}`);
    assert.equal(msgs.body.length, 1);
    assert.equal(msgs.body[0].group_id, groupId);
    assert.equal((await bob.get('/my_groups')).body[0].unread, 0, 'بازکردن گفتگو باید بخواندش');
});

test('اطلاعات گروه، افزودن عضو و خروج', async () => {
    const info = await alice.get(`/group_info/${groupId}`);
    assert.equal(info.body.success, true);
    assert.equal(info.body.members.length, 2);
    assert.equal(info.body.members[0].role, 'owner');

    assert.equal((await alice.post(`/group_add_member/${groupId}`, { user_id: eve.user.id })).body.success, true);
    assert.equal((await bob.post(`/group_add_member/${groupId}`, { user_id: eve.user.id })).status, 403);
    assert.equal((await eve.post(`/group_remove_member/${groupId}`, { user_id: eve.user.id })).body.success, true);
    assert.equal((await eve.get('/my_groups')).body.length, 0);
});

test('هدایت پیام به گروه و کاربر', async () => {
    const sent = await alice.upload('/send_message', { content: 'برای هدایت', group_id: groupId }, null);
    const fwd = await alice.post('/forward_message', {
        message_id: sent.body.message.id,
        targets: [{ type: 'group', id: groupId }, { type: 'user', id: eve.user.id }]
    });
    assert.equal(fwd.body.success, true);
    assert.equal(fwd.body.sent, 2);
    assert.equal((await bob.get(`/group_messages/${groupId}`)).body.length, 3);
});

/* ───────── اکسپلور ───────── */

let postId;

test('انتشار پست متنی', async () => {
    const r = await alice.upload('/create_post', { content: 'اولین پست شبکه #سلام' }, null);
    assert.equal(r.body.success, true);
    postId = r.body.post.id;

    const posts = await bob.get('/posts');
    assert.equal(posts.body.length, 1);
    assert.equal(posts.body[0].content, 'اولین پست شبکه #سلام');
    assert.equal(posts.body[0].likes_count, 0);
    assert.equal(posts.body[0].comments_count, 0);
    assert.equal(posts.body[0].liked_by_me, false);
    assert.equal(posts.body[0].followed_by_me, false);
});

test('لایک و برداشتن لایک', async () => {
    const like = await bob.post(`/like_post/${postId}`, { user_id: bob.user.id });
    assert.equal(like.body.liked, true);
    assert.equal(like.body.likes_count, 1);
    assert.equal((await bob.get('/posts')).body[0].liked_by_me, true);

    const unlike = await bob.post(`/like_post/${postId}`, { user_id: bob.user.id });
    assert.equal(unlike.body.liked, false);
    assert.equal(unlike.body.likes_count, 0);

    await bob.post(`/like_post/${postId}`, { user_id: bob.user.id }); /* برای ادامهٔ تست */
});

test('کامنت گذاشتن و خواندن', async () => {
    const c = await bob.post(`/comment_post/${postId}`, { user_id: bob.user.id, content: 'عالی بود' });
    assert.equal(c.body.success, true);
    assert.equal(c.body.comments_count, 1);
    const list = await alice.get(`/post_comments/${postId}`);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].full_name, 'bob');
    assert.equal(list.body[0].content, 'عالی بود');
});

test('بازدید پست و تاریخچهٔ تماشا', async () => {
    assert.equal((await bob.post(`/view_post/${postId}`, { user_id: bob.user.id })).body.views, 1);
    const history = await bob.get(`/history/${bob.user.id}`);
    assert.equal(history.body.length, 1);
    assert.equal(history.body[0].id, postId);
});

test('دنبال‌کردن و آمار پروفایل', async () => {
    assert.equal((await bob.post(`/follow/${alice.user.id}`, { user_id: bob.user.id })).body.following, true);
    assert.equal((await bob.get('/posts')).body[0].followed_by_me, true);

    const profile = await bob.get(`/user_profile/${bob.user.id}/${alice.user.id}`);
    assert.equal(profile.body.followers, 1);
    assert.equal(profile.body.following_count, 0);
    assert.equal(profile.body.posts_count, 1);
    assert.equal(profile.body.is_following, true);
});

test('اعلان‌ها برای لایک، کامنت و فالو ساخته می‌شوند', async () => {
    const r = await alice.get(`/notifications/${alice.user.id}`);
    assert.equal(r.body.items.length, 3);
    assert.deepEqual(r.body.items.map(n => n.type).sort(), ['comment', 'follow', 'like']);
    assert.equal(r.body.unread, 3);

    await alice.post(`/notifications_read/${alice.user.id}`, {});
    assert.equal((await alice.get(`/notifications/${alice.user.id}`)).body.unread, 0);
});

/* ───────── استوری ───────── */

let storyId;

test('انتشار استوری و دیدن آن توسط دیگران', async () => {
    const r = await alice.upload('/create_story', {}, 'story.png', PNG_1PX);
    assert.equal(r.body.success, true);
    storyId = r.body.story_id;

    const stories = await bob.get('/stories');
    assert.equal(stories.body.length, 1);
    assert.equal(stories.body[0].viewed_by_me, false);
    assert.ok(stories.body[0].expires_at > stories.body[0].created_at);
    assert.equal((await bob.get(`/files/stories/${encodeURIComponent(stories.body[0].file_path)}`)).status, 200);

    await bob.post(`/view_story/${storyId}`, { user_id: bob.user.id });
    assert.equal((await bob.get('/stories')).body[0].viewed_by_me, true);
});

test('بیننده‌های استوری فقط برای صاحبش', async () => {
    const owner = await alice.get(`/story_views/${storyId}`);
    assert.equal(owner.body.success, true);
    assert.equal(owner.body.viewers.length, 1);
    assert.equal(owner.body.viewers[0].full_name, 'bob');
    assert.equal((await bob.get(`/story_views/${storyId}`)).status, 403);
});

/* ───────── LAN ───────── */

test('ثبت، فهرست و حذف سرور بازی', async () => {
    assert.equal((await bob.post('/create_lan_host', { game_name: 'CS', ip_address: '999.1.1.1', port: '27015' })).body.success, false);

    const r = await bob.post('/create_lan_host', {
        game_name: 'Counter-Strike 1.6', ip_address: '192.168.1.20', port: '27015', description: 'سرور دث‌مچ'
    });
    assert.equal(r.body.success, true);

    const list = await alice.get('/lan_hosts');
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].ip_address, '192.168.1.20');
    assert.equal(list.body[0].full_name, 'bob');

    assert.equal((await eve.del(`/delete_lan_host/${list.body[0].id}`)).status, 403);
    assert.equal((await bob.del(`/delete_lan_host/${list.body[0].id}`)).body.success, true);
    assert.equal((await alice.get('/lan_hosts')).body.length, 0);
});

/* ───────── پروفایل ───────── */

test('ویرایش پروفایل با آواتار', async () => {
    const r = await bob.upload('/update_profile', { full_name: 'بابک', bio: 'عضو تیم' }, 'av.png', PNG_1PX);
    assert.equal(r.body.success, true);
    assert.equal(r.body.user.full_name, 'بابک');
    assert.ok(r.body.user.avatar);
    assert.equal((await bob.get(`/files/profiles/${encodeURIComponent(r.body.user.avatar)}`)).status, 200);
});

test('تغییر رمز و ورود با رمز تازه', async () => {
    assert.equal((await bob.post('/change_password', { old_password: 'nope', new_password: 'newpass1' })).body.success, false);
    assert.equal((await bob.post('/change_password', { old_password: 'pass1234', new_password: 'newpass1' })).body.success, true);

    const fresh = srv.client();
    assert.equal((await fresh.login('bob', 'newpass1')).status, 200);
    assert.equal((await fresh.login('bob', 'pass1234')).status, 401);
    bob.token = fresh.token;
});

/* ───────── ادمین ───────── */

test('کاربر عادی به پنل ادمین دسترسی ندارد', async () => {
    assert.equal((await eve.get('/api/admin/stats')).status, 403);
});

test('آمار و مدیریت کاربران توسط ادمین', async () => {
    const stats = await alice.get('/api/admin/stats');
    assert.equal(stats.status, 200);
    assert.equal(stats.body.total_users, 3);
    assert.equal(stats.body.total_groups, 1);
    assert.equal(stats.body.total_posts, 1);
    assert.equal(stats.body.total_likes, 1);
    assert.equal(stats.body.total_comments, 1);
    assert.equal(stats.body.total_follows, 1);
    assert.equal(stats.body.active_stories, 1);

    assert.equal((await alice.get('/api/admin/users')).body.length, 3);
    assert.equal((await alice.post(`/api/admin/promote_user/${bob.user.id}`, {})).body.user.role, 'admin');
    assert.equal((await alice.post(`/api/admin/demote_user/${bob.user.id}`, {})).body.user.role, 'user');
    assert.equal((await alice.post(`/api/admin/demote_user/${alice.user.id}`, {})).body.success, false);
});

test('حذف پست و پاک‌کردن همهٔ پیام‌ها توسط ادمین', async () => {
    assert.equal((await alice.del(`/api/admin/delete_post/${postId}`)).body.success, true);
    assert.equal((await alice.get('/posts')).body.length, 0);

    const clear = await alice.del('/api/admin/clear_all_messages');
    assert.equal(clear.body.success, true);
    assert.ok(clear.body.removed >= 2, `باید حداقل ۲ پیام پاک شده باشد، شد: ${clear.body.removed}`);
    assert.equal((await alice.get('/api/admin/stats')).body.total_messages, 0);
});

test('حذف کاربر همهٔ داده‌هایش را می‌برد', async () => {
    assert.equal((await alice.del(`/api/admin/delete_user/${eve.user.id}`)).body.success, true);
    assert.equal((await alice.get('/users')).body.length, 2);
    assert.equal((await alice.del(`/api/admin/delete_user/${alice.user.id}`)).body.success, false);
});

test('حذف گروه', async () => {
    assert.equal((await alice.del(`/group_delete/${groupId}`)).body.success, true);
    assert.equal((await alice.get('/my_groups')).body.length, 0);
});

test.after(async () => { if (srv) await srv.close(); });
