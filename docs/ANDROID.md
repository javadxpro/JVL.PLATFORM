# اپ بومی اندروید (`android/`)

رابط کاربری بومی با **Kotlin + Jetpack Compose** (راست‌به‌چپ)، بدون هیچ سرور و بدون
هیچ ذخیره‌سازی دائمی. همان شبکه‌ای است که کلاینت وب استفاده می‌کند؛ یک کاربرِ وب و
یک کاربرِ اندروید همدیگر را می‌بینند، به هم پیام می‌دهند و تماس می‌گیرند.

## معماری

| لایه | فایل | کار |
|---|---|---|
| اتصال | `net/MqttBus.kt` | کلاینت Paho روی `wss://…/mqtt`، یک اشتراک `jvl/<key>/v1/#`، Last Will برای حضور |
| پروتکل | `net/Topics.kt` | نقشهٔ تاپیک‌ها — **باید با `static/js/mqtt-backend.js` یکی باشد** |
| داده | `data/Repository.kt` | کشِ پیام‌های retained، ورود/ثبت‌نام، پیام، تیک‌دیده‌شده، ایندکس `phone/…` |
| مدل | `data/Models.kt` | همان شکل JSON کلاینت وب (`sender_id`, `file_path`, …) |
| مخاطبین | `contacts/ContactSync.kt`, `contacts/PhoneHash.kt` | خواندن با `ContactsContract` + هشِ شماره |
| تماس | `call/CallManager.kt` | WebRTC با `stream-webrtc-android`؛ سیگنال روی MQTT، رسانه P2P |
| پس‌زمینه | `service/BrokerService.kt` | سرویس پیش‌زمینه تا پیام و تماس در پس‌زمینه از دست نروند |
| رابط | `ui/*.kt` | Compose؛ همهٔ بخش‌ها در نوار بالا |

## چیزی که ذخیره نمی‌شود

فقط **شناسهٔ نشست** (id + نام کاربری) در `SharedPreferences` می‌ماند. پیام‌ها،
مخاطبینِ همسان‌سازی‌شده، و رسانه‌ها فقط در حافظه‌اند و با بستن اپ می‌روند.

## همسان‌سازی مخاطبین

1. شماره‌ها با `ContactsContract` از گوشی خوانده می‌شوند.
2. هر شماره با `PhoneHash.normalize` نرمال می‌شود (فقط رقم، با پیش‌شمارهٔ کشور:
   `۰۹۱۲…` → `۹۸۹۱۲…`، `۰۰۹۸…` → `۹۸۹۱۲…`، `+۹۸۹۱۲…` → `۹۸۹۱۲…`).
3. هش = `'p' + SHA-256("jvl-phone:" + رقم‌ها).take(24)`.
4. هش با کشِ محلیِ تاپیک‌های `phone/<hash>` مقایسه می‌شود.

**شمارهٔ خام هرگز از دستگاه بیرون نمی‌رود.** این الگوریتم دقیقاً با کلاینت وب یکی است
(در همان فایل `PhoneHash.kt` مستند شده)، پس کاربری که از مرورگر ثبت‌نام کرده با
همان شماره از اپ بومی هم پیدا می‌شود.

> هش با `MessageDigest("SHA-256")` ساخته می‌شود؛ کلاینت وب از `crypto.subtle`
> استفاده می‌کند که همان SHA-256 است. اگر وب را روی `http://` (نه HTTPS و نه
> localhost) باز کنی، SubtleCrypto در دسترس نیست و وب به هشِ جایگزینِ ضعیف می‌افتد —
> در آن حالت دو طرف جور درنمی‌آیند. **همیشه روی HTTPS باز کن.**

## تماس

- سیگنال (`offer` / `accept` / `signal` / `reject` / `end`) روی `evt/call/<uid>`.
- رسانه **P2P** است؛ هیچ سرور رسانه‌ای در کار نیست.
- ICE: سه STUN عمومی. اگر NAT طرفین متقارن باشد وصل نمی‌شود؛ آن‌وقت یک TURN بگذار:

```kotlin
CallManager.TURN_URL = "turn:turn.example.com:3478"
CallManager.TURN_USER = "user"
CallManager.TURN_PASS = "pass"
```

## مجوزها

`INTERNET`, `ACCESS_NETWORK_STATE`, `RECORD_AUDIO`, `CAMERA`, `MODIFY_AUDIO_SETTINGS`,
`READ_CONTACTS`, `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_PHONE_CALL`,
`WAKE_LOCK`, `VIBRATE`

## ساخت APK

این پروژه در این سندباکس نوشته شده و **آنجا کامپایل نشده** (نه Android SDK هست،
نه دسترسی به Maven). برای ساخت:

```bash
cd android
gradle wrapper --gradle-version 8.11.1   # فایل wrapper در ریپازیتوری نیست
./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

یا بدون هیچ نصبی روی کامپیوتر خودت: ورک‌فلو **`.github/workflows/android.yml`** را
اجرا کن (GitHub Actions → *Android APK* → *Run workflow*). یک APK دیباگ به‌عنوان
artifact بالا می‌آید.

### قبل از اولین ساخت

- **نسخهٔ وابستگی‌ها** در `android/gradle/libs.versions.toml` را با آخرین نسخهٔ پایدار
  Maven Central / Google تطبیق بده؛ من به Maven دسترسی نداشتم و نتوانستم آن‌ها را
  تأیید کنم.
- `MQTT_NETWORK_KEY` در `android/app/build.gradle.kts` باید با کلاینت وب یکی باشد
  (`volexturn4`)، وگرنه دو طرف در دو شبکهٔ جدا می‌مانند.
- برای APK امضا‌شده، `signingConfig` خودت را به `buildTypes.release` اضافه کن.
