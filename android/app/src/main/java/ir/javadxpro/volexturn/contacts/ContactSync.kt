package ir.javadxpro.volexturn.contacts

import android.content.Context
import android.provider.ContactsContract

data class DeviceContact(val name: String, val phone: String)

/**
 * خواندن مخاطبین گوشی با ContactsContract. بعد از خواندن، فقط هشِ شماره‌ها
 * با کشِ محلی مقایسه می‌شود؛ شمارهٔ خام از دستگاه بیرون نمی‌رود.
 */
object ContactSync {

    fun read(context: Context): List<DeviceContact> {
        val out = ArrayList<DeviceContact>()
        val cursor = context.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                ContactsContract.CommonDataKinds.Phone.NUMBER
            ),
            null, null, null
        ) ?: return out
        cursor.use { c ->
            val nameIdx = c.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
            val numIdx = c.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
            while (c.moveToNext()) {
                val name = if (nameIdx >= 0) c.getString(nameIdx) ?: "" else ""
                val num = if (numIdx >= 0) c.getString(numIdx) ?: "" else ""
                if (PhoneHash.normalize(num).isNotEmpty()) out.add(DeviceContact(name, num))
            }
        }
        return out
    }
}
