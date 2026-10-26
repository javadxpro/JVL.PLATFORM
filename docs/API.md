# مستند API سرور JVL.PLATFORM

همهٔ مسیرها دقیقاً همان‌هایی هستند که `index.html` صدا می‌زند.
مسیرهای محافظت‌شده هدر `Authorization: Bearer <token>` می‌خواهند و در صورت توکن
نامعتبر `401` برمی‌گردانند (کلاینت با دیدن ۴۰۱ خودش لاگ‌اوت می‌کند).

> **دو پیاده‌سازی، یک قرارداد.** همین جدول را `server/routes/*.js` با Express و
> `static/js/mqtt-backend.js` روی MQTT پیاده‌سازی می‌کنند؛ `index.html` فرقشان را
> نمی‌فهمد. برای جزئیات حالت MQTT (نقشهٔ تاپیک‌ها، حضور با Last Will، محدودیت‌ها)
> به **[docs/MQTT.md](MQTT.md)** برو.

- مهر زمانی همه‌جا رشتهٔ محلی `YYYY-MM-DD HH:MM:SS` است.
- مسیرهای `POST` که فایل می‌گیرند `multipart/form-data` هستند؛ بقیهٔ `POST`ها `application/json`.
- پاسخ خطا همیشه `{ "success": false, "message": "…" }` است.

## ۱. عمومی (بدون توکن)

| مسیر | توضیح |
|---|---|
| `GET /` | خودِ `index.html` |
| `GET /<هرچیز غیر از /api>` | همان `index.html` (کلاینت تک‌صفحه‌ای) |
| `GET /api/app_info` | `{name, version, node, limits, story_ttl_hours, urls}` — برای تشخیص کش بودن نسخهٔ قدیمی صفحه |
| `GET /api/health` | `{ok, version}` |
| `GET /static/js/socket.io.min.js` | کلاینت Socket.IO از `node_modules` |
| `GET /static/fonts/:file` | فونت وزیرمتن (فقط `*.woff`/`*.woff2`) |
| `GET /files/:kind/:name` | فایل‌های آپلودشده؛ `kind` یکی از `chat | posts | stories | profiles`. با پشتیبانی `Range` برای پخش ویدیو |

## ۲. احراز هویت

| مسیر | بدنه | پاسخ |
|---|---|---|
| `POST /register` | `{username, password}` | `{success, message, user}` — اولین کاربر `role: "admin"` می‌شود |
| `POST /login` | `{username, password}` | `{success, user, token}` یا `401` |

## ۳. کاربران، پروفایل، فالو، اعلان

| مسیر | بدنه | پاسخ |
|---|---|---|
| `GET /users` | — | `[user]` با `is_online` زنده |
| `GET /unread_counts/:me` | — | `{"3": 2}` — پیام‌های خوانده‌نشده به تفکیک فرستنده |
| `GET /user_profile/:me/:uid` | — | پروفایل + `posts_count`, `followers`, `following_count`, `is_following`, `is_online` |
| `POST /follow/:uid` | `{user_id}` | `{success, following}` |
| `GET /notifications/:uid` | — | `{unread, items:[notification]}` |
| `POST /notifications_read/:uid` | — | `{success}` |
| `POST /update_profile` | `full_name`, `bio`, `avatar`(فایل) | `{success, user}` |
| `POST /change_password` | `{old_password, new_password}` | `{success, message}` |

## ۴. چت

| مسیر | بدنه | پاسخ |
|---|---|---|
| `GET /messages/:me/:peer` | — | `[message]` صعودی بر اساس زمان |
| `GET /group_messages/:gid` | — | `[message]` — همزمان پیام‌های گروه برای درخواست‌دهنده خوانده‌شده علامت می‌خورد |
| `POST /send_message` | `content` یا `file`، به‌همراه `receiver_id` **یا** `group_id`، و `reply_to_id` اختیاری | `{success, message}` |
| `POST /seen_messages/:sender` | `{me}` | `{success, updated}` |
| `POST /pin_message/:mid` | `{user_id}` | `{success, pinned}` — در هر گفتگو فقط یک پیام سنجاق‌شده |
| `POST /edit_message` | `{message_id, user_id, content}` | `{success, message}` — فقط نویسنده (یا مدیر) |
| `DELETE /delete_message/:mid?uid=` | — | `{success}` |
| `POST /forward_message` | `{message_id, targets:[{type:"user"\|"group", id}]}` | `{success, sent}` — فایل هم کپی می‌شود تا با حذف پیام اصلی لینک مقصدها نشکند |

## ۵. گروه‌ها

| مسیر | بدنه | پاسخ |
|---|---|---|
| `GET /my_groups` | — | `[group]` با `members_count`, `unread`, `last_content`, `last_file` |
| `POST /create_group` | `{name, members:[uid]}` | `{success, message, group_id}` |
| `GET /group_info/:gid` | — | `{success, group, members:[{…user, role}]}` |
| `POST /group_add_member/:gid` | `{user_id}` | `{success}` — فقط مالک یا مدیر |
| `POST /group_remove_member/:gid` | `{user_id}` | `{success}` — مالک برای دیگران، هر عضو برای خودش |
| `DELETE /group_delete/:gid` | — | `{success}` — مالک یا مدیر |

## ۶. اکسپلور (پست و استوری)

| مسیر | بدنه | پاسخ |
|---|---|---|
| `GET /posts` | — | `[post]` نزولی، با شمارش‌ها و `liked_by_me`/`followed_by_me` |
| `POST /create_post` | `content` و/یا `file` | `{success, post}` |
| `POST /like_post/:pid` | `{user_id}` | `{success, liked, likes_count}` — کلید قطع/وصل |
| `POST /view_post/:pid` | `{user_id}` | `{success, views}` |
| `GET /post_comments/:pid` | — | `[comment]` |
| `POST /comment_post/:pid` | `{user_id, content}` | `{success, comment_id, comments_count}` |
| `GET /history/:uid` | — | پست‌هایی که کاربر دیده (تاریخچهٔ تماشا) |
| `GET /stories` | — | `[story]` فعال (منقضی‌شده‌ها خودکار پاک می‌شوند) |
| `POST /create_story` | `file` (عکس یا ویدیو) | `{success, story_id, expires_at}` |
| `POST /view_story/:sid` | `{user_id}` | `{success}` |
| `GET /story_views/:sid` | — | `{success, viewers:[user]}` — فقط صاحب استوری یا مدیر |

## ۷. سرورهای بازی LAN

| مسیر | بدنه | پاسخ |
|---|---|---|
| `GET /lan_hosts` | — | `[lan_host]` |
| `POST /create_lan_host` | `{game_name, ip_address, port, description}` | `{success, id}` — IP یا نام میزبان اعتبارسنجی می‌شود |
| `DELETE /delete_lan_host/:id` | — | `{success}` — سازنده یا مدیر |

## ۸. پنل مدیر (`/api/admin/*` — فقط `role: "admin"`)

| مسیر | پاسخ |
|---|---|
| `GET /api/admin/stats` | `{total_users, total_groups, total_messages, total_posts, total_likes, total_comments, total_follows, active_stories, online_now}` |
| `GET /api/admin/users` | `[user]` + `posts_count`, `messages_count`, `last_seen_at`, `banned`, `banned_reason`, `banned_at`, `last_ip` — این چهار فیلد فقط در همین مسیر می‌آیند، نه در `serializeUser` عمومی |
| `POST /api/admin/promote_user/:id` | `{success, user}` |
| `POST /api/admin/demote_user/:id` | `{success, user}` — تنزل خود مجاز نیست |
| `POST /api/admin/ban_user/:id` | `{reason?, ban_ip?=true, cidr?}` → `{success, message, user, banned_ip, ip_error, kicked}` — حساب و نشانی آخرین نشست با هم بسته می‌شوند؛ بنِ خود مجاز نیست |
| `POST /api/admin/unban_user/:id` | `{unban_ip?=false}` → `{success, message, user, unbanned_ip}` — بازگرداندن نشانی اختیاری است |
| `GET /api/admin/banned_ips` | `[{ip, reason, banned_by, banned_by_name, created_at}]` |
| `POST /api/admin/ban_ip` | `{ip, reason?}` → `{success, ip}` — `ip` تک‌نشانی یا CIDR است (`91.98.7.0/24`)؛ بستن `127.0.0.1`/`::1` رد می‌شود |
| `DELETE /api/admin/unban_ip/:ip` | `{success}` — اگر نشانی در فهرست نباشد ۴۰۴ |
| `DELETE /api/admin/delete_user/:id` | `{success}` — فایل‌ها هم پاک می‌شوند؛ حذف خود مجاز نیست |
| `DELETE /api/admin/delete_post/:id` | `{success}` |
| `DELETE /api/admin/clear_all_messages` | `{success, removed}` |

---

# شکل داده‌ها

```js
user        { id, username, full_name, bio, avatar, role: "user"|"admin", created_at, is_online }

> پاسخ هر مسیرِ بن‌شده `{success:false, banned:true, message}` با وضعیت **۴۰۳** است.
> این پاسخ قبل از هر مسیری برمی‌گردد — از جمله `/login` و `/register` — پس با حساب
> تازه نمی‌شود از بن رد شد.
message     { id, sender_id, sender_name, receiver_id, group_id, content,
              file_path, file_name, file_type: "image"|"video"|"audio"|"file",
              reply_to_id, reply_content, reply_file_name, reply_sender_name,
              pinned, forwarded, seen, edited_at, timestamp }
group       { id, name, creator_id, created_at, my_role, members_count, unread, last_content, last_file }
post        { id, user_id, full_name, username, avatar, content, file_path, file_name, file_type,
              views, timestamp, likes_count, comments_count, liked_by_me, followed_by_me }
comment     { id, user_id, full_name, username, avatar, content, timestamp }
story       { id, user_id, full_name, username, avatar, file_path, file_type, created_at, expires_at, viewed_by_me }
notification{ id, type: "like"|"comment"|"follow", post_id, actor_id, actor_name, is_read, timestamp }
lan_host    { id, user_id, full_name, username, game_name, ip_address, port, description, created_at }
```

مسیر فایل‌ها در پاسخ‌ها **فقط نام فایل** است و کلاینت خودش پیشوند می‌زند:
`/files/chat/<file_path>`، `/files/posts/…`، `/files/stories/…`، `/files/profiles/…`.

---

# رویدادهای Socket.IO

## کلاینت → سرور

| رویداد | داده | کار سرور |
|---|---|---|
| `join` | `{user_id}` | عضویت در اتاق `user:<id>`، ثبت حضور، انتشار `user_status` |
| `typing` | `{from, to, scope:"user"\|"group", name}` | رله به مخاطب (یا اعضای گروه جز فرستنده) |
| `join_voice` | `{room, user_id}` | عضویت در اتاق خام (`global_voice`) |
| `leave_voice` | `{room, user_id}` | خروج از اتاق |
| `voice_signal` | `{room, sender, signal:{sdp? candidate?}}` | رله به بقیهٔ اعضای اتاق |

## سرور → کلاینت

| رویداد | داده | چه زمانی |
|---|---|---|
| `new_message` | `message` | ارسال یا هدایت پیام، به همهٔ طرفین گفتگو |
| `user_status` | `{online:[id], at}` | وصل/قطع شدن هر کاربر |
| `groups_changed` | `{at}` | ساخت گروه یا تغییر اعضا |
| `message_updated` | `{message_id}` | ویرایش پیام |
| `message_deleted` | `{message_id}` یا `{all, by}` | حذف پیام یا پاک‌سازی کلی توسط مدیر |
| `messages_seen` | `{by, partner, count}` | خوانده‌شدن پیام‌ها |
| `messages_pin` | `{message_id, pinned}` | سنجاق/رفع سنجاق |
| `typing` | `{from, to, scope, name}` | رلهٔ «در حال نوشتن» |
| `notify` | `notification` | لایک/کامنت/فالو برای صاحب اثر |
| `post_like` | `{post_id, likes_count, liked, user_id}` | هر لایک (پخش سراسری) |
| `post_comment` | `{post_id, comments_count, user_id}` | ثبت نظر |
| `post_view` | `{post_id, views}` | ثبت بازدید ویدیو |
| `post_deleted` | `{post_id}` | حذف پست توسط مدیر |
| `follow_update` | `{target_id, follower_id, following}` | تغییر وضعیت دنبال‌کردن |
| `voice_signal` | `{room, sender, signal}` | رلهٔ سیگنال WebRTC |
| `banned` | `{message, ip?}` | بن‌شدن حساب یا نشانی — بلافاصله بعدش اتصال قطع می‌شود و کلاینت نشست را پاک می‌کند |

> اتاق‌ها `user:<id>` و نام خام اتاق ویس هستند. رویدادهای مربوط به گروه به اتاق
> `user:` همهٔ اعضا فرستاده می‌شوند، چون کلاینت هرگز عضو اتاق گروه نمی‌شود.

## کانال‌ها

| مسیر | پاسخ |
|---|---|
| `POST /create_channel` | `{success, channel_id, channel}` — نام خالی/تکراری رد می‌شود |
| `GET /channels` | `[channel]` — عضو‌شده‌ها اول؛ هر کدام `subscribers`, `subscribed`, `posts`, `is_owner` |
| `GET /channel_info/:cid` | `channel` یا ۴۰۴ |
| `POST /channel_subscribe/:cid` | `{subscribed, subscribers}` — مالک نمی‌تواند عضویتش را لغو کند |
| `POST /channel_post/:cid` | `{post}` — فقط مالک/مدیر؛ غیرمالک ۴۰۳ |
| `GET /channel_posts/:cid` | `[post]` با `views`, `viewed_by_me`, `comments` |
| `POST /channel_view/:pid` | `{views}` — برای هر کاربر یک‌بار شمرده می‌شود |
| `POST /channel_comment/:pid` | `{comment}` |
| `GET /channel_comments/:pid` | `[comment]` |
| `DELETE /channel_delete/:cid` | فقط مالک/مدیر؛ بقیه ۴۰۳ |

## اعلان روی گوشی (Web Push)

| مسیر | پاسخ |
|---|---|
| `GET /push_public_key` | `{publicKey}` — بدون احراز هویت؛ کلید VAPID برای `pushManager.subscribe` |
| `POST /push_subscribe` | `{devices}` — بدنه: `{endpoint, p256dh, auth}` |
| `POST /push_unsubscribe` | `{removed, devices}` — بدنه: `{endpoint}` |

کلیدهای VAPID یک‌بار ساخته و در `data/vapid.json` (با مجوز ۰۶۰۰) نگه داشته می‌شوند؛
با `JVL_VAPID_PUBLIC` / `JVL_VAPID_PRIVATE` قابل بازنویسی‌اند. اشتراک‌های مرده
(۴۰۴/۴۱۰) هنگام ارسال پاک می‌شوند.

| رویداد سوکت | بار | توضیح |
|---|---|---|
| `call_offer` | `{to, callId, video, from, fromName}` | رلهٔ تماس + پوش اگر طرف آفلاین باشد |
| `call_accept` / `call_signal` / `call_reject` / `call_end` | `{to, callId, …, from, fromName}` | رلهٔ سیگنال WebRTC بین دو نفر |
