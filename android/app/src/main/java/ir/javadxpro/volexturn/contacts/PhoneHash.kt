package ir.javadxpro.volexturn.contacts

import java.security.MessageDigest

/**
 * نرمال‌سازی و هش شمارهٔ تلفن — باید بایت‌به‌بایت با کلاینت وب یکی باشد
 * (static/js/mqtt-backend.js → normalizePhone / phoneHash)، وگرنه مخاطبینِ
 * اپ بومی با مخاطبینِ مرورگر جور درنمی‌آیند.
 *
 * شمارهٔ خام هرگز منتشر نمی‌شود؛ فقط هشِ آن روی تاپیک phone/<hash> می‌نشیند.
 */
object PhoneHash {

    /** فقط رقم، با پیش‌شمارهٔ کشور. ۰۹۱۲… → ۹۸۹۱۲… */
    fun normalize(raw: String?): String {
        var d = (raw ?: "").filter { it.isDigit() }
        if (d.isEmpty()) return ""
        if (d.startsWith("00")) d = d.substring(2)
        if (d.length == 11 && d.startsWith("0")) d = "98" + d.substring(1)
        if (d.length == 10 && d.startsWith("9")) d = "98" + d
        return d
    }

    fun hash(raw: String?): String {
        val d = normalize(raw)
        if (d.isEmpty()) return ""
        return "p" + sha256Hex("jvl-phone:$d").take(24)
    }

    private fun sha256Hex(text: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
        val sb = StringBuilder(digest.size * 2)
        for (b in digest) {
            val v = b.toInt() and 0xFF
            if (v < 0x10) sb.append('0')
            sb.append(Integer.toHexString(v))
        }
        return sb.toString()
    }
}
