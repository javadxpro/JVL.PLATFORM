package ir.javadxpro.volexturn.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import ir.javadxpro.volexturn.MainActivity
import ir.javadxpro.volexturn.R
import ir.javadxpro.volexturn.VolexturnApp
import ir.javadxpro.volexturn.net.MqttBus
import org.json.JSONObject

/**
 * سرویس پیش‌زمینه تا اتصال MQTT (و در نتیجه دریافت پیام و تماس) وقتی اپ
 * در پس‌زمینه است قطع نشود. هیچ داده‌ای ذخیره نمی‌کند.
 */
class BrokerService : Service(), MqttBus.Listener {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIF_ID, buildNotification("متصل به شبکه"))
        VolexturnApp.instance.bus.addListener(this)
        return START_STICKY
    }

    override fun onDestroy() {
        VolexturnApp.instance.bus.removeListener(this)
        super.onDestroy()
    }

    override fun onEvent(tail: String, json: JSONObject) {
        if (!tail.startsWith("dm/") && !tail.startsWith("call/")) return
        if (json.optString("t") == "msg") {
            val m = json.optJSONObject("m") ?: return
            notify("${m.optString("sender_name", "پیام جدید")}: ${m.optString("content", "")}")
        }
        if (tail.startsWith("call/") && json.optString("t") == "offer") {
            notify(getString(R.string.incoming_call) + " — " + json.optString("fromName", ""))
        }
    }

    override fun onConnected() = update("متصل به شبکه")
    override fun onDisconnected() = update("در حال اتصال مجدد…")

    private fun update(text: String) {
        val nm = getSystemService(NotificationManagerCompat())
        nm?.notify(NOTIF_ID, buildNotification(text))
    }

    private fun notify(text: String) {
        val nm = getSystemService(NotificationManagerCompat())
        nm?.notify((System.currentTimeMillis() % 100000).toInt(), buildNotification(text, alert = true))
    }

    private fun buildNotification(text: String, alert: Boolean = false): Notification {
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, VolexturnApp.CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(pi)
            .setOngoing(!alert)
            .setPriority(if (alert) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_LOW)
            .build()
    }

    @Suppress("UNCHECKED_CAST")
    private fun NotificationManagerCompat(): Class<android.app.NotificationManager> =
        android.app.NotificationManager::class.java

    companion object {
        private const val NOTIF_ID = 4201
        fun start(context: android.content.Context) {
            val i = Intent(context, BrokerService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(i)
            else context.startService(i)
        }
    }
}
