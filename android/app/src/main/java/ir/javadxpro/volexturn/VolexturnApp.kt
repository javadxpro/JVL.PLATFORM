package ir.javadxpro.volexturn

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import ir.javadxpro.volexturn.call.CallManager
import ir.javadxpro.volexturn.data.Repository
import ir.javadxpro.volexturn.net.MqttBus

/**
 * تک‌نمونهٔ سراسری. کل «بک‌اند» همین سه آبجکت است:
 * MqttBus (اتصال) → Repository (کش retained) → CallManager (WebRTC).
 */
class VolexturnApp : Application() {

    lateinit var bus: MqttBus
        private set
    lateinit var repo: Repository
        private set
    lateinit var calls: CallManager
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        bus = MqttBus(BuildConfig.MQTT_BROKER, BuildConfig.MQTT_NETWORK_KEY)
        repo = Repository(bus, BuildConfig.MQTT_NETWORK_KEY)
        calls = CallManager(this, repo)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.notif_channel),
                    NotificationManager.IMPORTANCE_HIGH
                )
            )
        }

        /* اتصال بی‌هویت از همان ابتدا، تا ورود منتظر handshake نماند */
        bus.connect(
            clientId = "jvl_android_anon_${(1000..9999).random()}",
            willTopic = null,
            willPayload = null
        )
    }

    companion object {
        const val CHANNEL_ID = "volexturn"
        lateinit var instance: VolexturnApp
            private set
    }
}
