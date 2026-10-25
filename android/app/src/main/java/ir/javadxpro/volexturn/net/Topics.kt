package ir.javadxpro.volexturn.net

/**
 * نقشهٔ تاپیک‌ها — باید دقیقاً با کلاینت وب (static/js/mqtt-backend.js) یکی باشد،
 * وگرنه اپ بومی و مرورگر همدیگر را نمی‌بینند.
 *
 * پیشوند همهٔ تاپیک‌ها: jvl/<networkKey>/v1
 *  - state: پیام retained روی تاپیک، payload خالی یعنی حذف
 *  - رویداد: پیام غیر retained زیر …/evt/
 */
object Topics {
    const val VERSION = "v1"

    fun prefix(networkKey: String) = "jvl/$networkKey/$VERSION"
    fun wildcard(networkKey: String) = "${prefix(networkKey)}/#"

    /* ── state (retained) ── */
    fun user(p: String, id: Long) = "${prefix(p)}/user/$id"
    fun uname(p: String, username: String) = "${prefix(p)}/uname/${username.lowercase()}"
    fun presence(p: String, id: Long) = "${prefix(p)}/presence/$id"
    fun phone(p: String, hash: String) = "${prefix(p)}/phone/$hash"
    fun group(p: String, id: Long) = "${prefix(p)}/group/$id"
    fun member(p: String, gid: Long, uid: Long) = "${prefix(p)}/member/$gid/$uid"
    fun post(p: String, id: Long) = "${prefix(p)}/post/$id"
    fun like(p: String, pid: Long, uid: Long) = "${prefix(p)}/like/$pid/$uid"
    fun story(p: String, id: Long) = "${prefix(p)}/story/$id"
    fun follow(p: String, a: Long, b: Long) = "${prefix(p)}/follow/$a/$b"
    fun lan(p: String, id: Long) = "${prefix(p)}/lan/$id"
    fun pin(p: String, scope: String) = "${prefix(p)}/pin/$scope"

    /* ── رویدادها (غیر retained) ── */
    fun evtDm(p: String, uid: Long) = "${prefix(p)}/evt/dm/$uid"
    fun evtGroup(p: String, gid: Long) = "${prefix(p)}/evt/group/$gid"
    fun evtNotify(p: String, uid: Long) = "${prefix(p)}/evt/notify/$uid"
    fun evtCall(p: String, uid: Long) = "${prefix(p)}/evt/call/$uid"
    fun evtVoice(p: String, room: String) = "${prefix(p)}/evt/voice/$room"
    fun evtGlobal(p: String) = "${prefix(p)}/evt/global"

    /** نوع تاپیک state از روی آدرس کامل */
    sealed class Kind {
        data class User(val id: Long) : Kind()
        data class Uname(val id: Long) : Kind()
        data class Presence(val id: Long) : Kind()
        data class Phone(val hash: String) : Kind()
        data class Group(val id: Long) : Kind()
        data class Member(val gid: Long, val uid: Long) : Kind()
        data class Post(val id: Long) : Kind()
        data class Story(val id: Long) : Kind()
        data class Lan(val id: Long) : Kind()
        object Other : Kind()
    }

    fun classify(p: String, topic: String): Kind {
        val rest = topic.removePrefix(prefix(p) + "/")
        val parts = rest.split("/")
        if (parts.size < 2) return Kind.Other
        val id = parts[1].toLongOrNull()
        return when (parts[0]) {
            "user" -> if (id != null) Kind.User(id) else Kind.Other
            "uname" -> id?.let { Kind.Uname(it) } ?: Kind.Other
            "presence" -> if (id != null) Kind.Presence(id) else Kind.Other
            "phone" -> Kind.Phone(parts[1])
            "group" -> if (id != null) Kind.Group(id) else Kind.Other
            "member" -> if (parts.size >= 3) Kind.Member(parts[1].toLongOrNull() ?: 0, parts[2].toLongOrNull() ?: 0) else Kind.Other
            "post" -> if (id != null) Kind.Post(id) else Kind.Other
            "story" -> if (id != null) Kind.Story(id) else Kind.Other
            "lan" -> if (id != null) Kind.Lan(id) else Kind.Other
            else -> Kind.Other
        }
    }

    /** بخش پس از …/evt/ برای تشخیص نوع رویداد */
    fun eventTail(p: String, topic: String): String =
        topic.removePrefix(prefix(p) + "/evt/")

    /** مثل کلاینت وب: Date.now()*100 + rand */
    fun newId(): Long = System.currentTimeMillis() * 100 + (0..99).random()

    /** قالب زمانی که کلاینت وب انتظار دارد: yyyy-MM-dd HH:mm:ss */
    fun now(): String = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US)
        .format(java.util.Date())
}
