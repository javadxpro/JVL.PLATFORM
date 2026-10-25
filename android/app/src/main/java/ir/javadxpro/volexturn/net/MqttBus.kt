package ir.javadxpro.volexturn.net

import org.eclipse.paho.client.mqttv3.IMqttDeliveryToken
import org.eclipse.paho.client.mqttv3.MqttCallbackExtended
import org.eclipse.paho.client.mqttv3.MqttClient
import org.eclipse.paho.client.mqttv3.MqttConnectOptions
import org.eclipse.paho.client.mqttv3.MqttMessage
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList

/**
 * لایهٔ MQTT اپ بومی. تمام «سرور» همین است: state با پیام‌های retained،
 * رویدادها غیر retained، و حضور با Last Will.
 *
 * هیچ دیتابیس و دیسکی در کار نیست؛ کش فقط در حافظه است و با بستن اپ می‌رود.
 */
class MqttBus(
    private val brokerUrl: String,
    private val networkKey: String
) {
    interface Listener {
        /** پیام retained روی یک تاپیک state؛ payload خالی یعنی حذف */
        fun onDoc(topic: String, payload: String?) {}
        /** رویداد غیر retained زیر …/evt/ */
        fun onEvent(tail: String, json: JSONObject) {}
        fun onConnected() {}
        fun onDisconnected() {}
    }

    private val listeners = CopyOnWriteArrayList<Listener>()
    @Volatile private var client: MqttClient? = null
    @Volatile var connected: Boolean = false
        private set

    fun addListener(l: Listener) { listeners.addIfAbsent(l) }
    fun removeListener(l: Listener) { listeners.remove(l) }

    /**
     * @param willTopic تاپیک حضورِ خودم؛ با بسته‌شدن اپ بروکر آفلاین را retained می‌کند
     */
    fun connect(clientId: String, willTopic: String?, willPayload: JSONObject?) {
        if (client?.isConnected == true) return
        val c = MqttClient(clientId, MemoryPersistence())
        val opts = MqttConnectOptions().apply {
            isCleanSession = true
            connectionTimeout = 15
            keepAliveInterval = 30
            isAutomaticReconnect = true
            mqttVersion = MqttConnectOptions.MQTT_VERSION_3_1_1
            if (willTopic != null && willPayload != null) {
                val m = MqttMessage(willPayload.toString().toByteArray()).apply {
                    qos = 1; isRetained = true
                }
                setWill(willTopic, m.payload, m.qos, m.isRetained)
            }
        }
        c.setCallback(object : MqttCallbackExtended {
            override fun connectComplete(reconnect: Boolean, serverURI: String?) {
                connected = true
                try { c.subscribe(Topics.wildcard(networkKey), 1) } catch (_: Exception) {}
                listeners.forEach { it.onConnected() }
            }

            override fun connectionLost(cause: Throwable?) {
                connected = false
                listeners.forEach { it.onDisconnected() }
            }

            override fun messageArrived(topic: String, message: MqttMessage) {
                val text = String(message.payload, Charsets.UTF_8)
                if (topic.startsWith(Topics.prefix(networkKey) + "/evt/")) {
                    if (text.isEmpty()) return
                    val json = try { JSONObject(text) } catch (e: Exception) { return }
                    val tail = Topics.eventTail(networkKey, topic)
                    listeners.forEach { it.onEvent(tail, json) }
                } else {
                    val payload = if (text.isEmpty()) null else text
                    listeners.forEach { it.onDoc(topic, payload) }
                }
            }

            override fun deliveryComplete(token: IMqttDeliveryToken?) {}
        })
        client = c
        c.connect(opts)
    }

    fun publish(topic: String, payload: String?, retain: Boolean = true, qos: Int = 1) {
        val c = client ?: return
        val bytes = (payload ?: "").toByteArray(Charsets.UTF_8)
        val m = MqttMessage(bytes).apply { this.qos = qos; this.isRetained = retain }
        c.publish(topic, m)
    }

    fun publishJson(topic: String, json: JSONObject, retain: Boolean = true) =
        publish(topic, json.toString(), retain)

    fun disconnect() {
        try { client?.disconnect()?.waitForCompletion(1000) } catch (_: Exception) {}
        try { client?.close() } catch (_: Exception) {}
        client = null
        connected = false
    }
}
