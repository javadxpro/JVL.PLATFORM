package ir.javadxpro.volexturn.call

import android.content.Context
import ir.javadxpro.volexturn.data.CallSignalBus
import ir.javadxpro.volexturn.data.Repository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONObject
import stream.webrtc.android.Camera2Enumerator
import stream.webrtc.android.DefaultVideoDecoderFactory
import stream.webrtc.android.DefaultVideoEncoderFactory
import stream.webrtc.android.EglBase
import stream.webrtc.android.IceCandidate
import stream.webrtc.android.JavaAudioDeviceModule
import stream.webrtc.android.MediaConstraints
import stream.webrtc.android.MediaStream
import stream.webrtc.android.PeerConnection
import stream.webrtc.android.PeerConnectionFactory
import stream.webrtc.android.SdpObserver
import stream.webrtc.android.SessionDescription
import stream.webrtc.android.SurfaceViewRenderer
import stream.webrtc.android.VideoTrack
import java.util.UUID

enum class CallState { IDLE, CALLING, INCOMING, CONNECTING, CONNECTED, ENDED }

/**
 * تماس WebRTC یک‌به‌یک. رسانه P2P است و فقط سیگنال (offer/answer/ICE)
 * روی MQTT می‌رود — یعنی هیچ سرور رسانه‌ای در کار نیست.
 *
 * اگر NAT طرفین متقارن باشد، بدون TURN وصل نمی‌شود؛ در آن صورت آدرس TURN
 * خودت را در TURN_URL بگذار.
 */
class CallManager(
    private val context: Context,
    private val repo: Repository
) {
    companion object {
        val STUN = listOf(
            "stun:stun.l.google.com:19302",
            "stun:stun1.l.google.com:19302",
            "stun:stun.cloudflare.com:3478"
        )
        /** اختیاری: "turn:host:3478" */
        var TURN_URL: String? = null
        var TURN_USER: String? = null
        var TURN_PASS: String? = null
    }

    private val _state = MutableStateFlow(CallState.IDLE)
    val state: StateFlow<CallState> = _state

    private val _peerName = MutableStateFlow("")
    val peerName: StateFlow<String> = _peerName

    private val eglBase: EglBase by lazy { EglBase.create() }
    private val factory: PeerConnectionFactory by lazy {
        val audio = JavaAudioDeviceModule.builder(context).createAudioDeviceModule()
        val encoder = DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true)
        val decoder = DefaultVideoDecoderFactory(eglBase.eglBaseContext)
        PeerConnectionFactory.builder()
            .setAudioDeviceModule(audio)
            .setVideoEncoderFactory(encoder)
            .setVideoDecoderFactory(decoder)
            .createPeerConnectionFactory()
    }

    private var pc: PeerConnection? = null
    private var localStream: MediaStream? = null
    private var peerId: Long = 0
    private var callId: String = ""
    private var isCaller = false
    private var wantVideo = false
    private var remoteTrack: VideoTrack? = null

    init {
        CallSignalBus.handler = { json -> onSignal(json) }
    }

    fun iceServers(): List<PeerConnection.IceServer> {
        val list = STUN.map { PeerConnection.IceServer.builder(it).createIceServer() }.toMutableList()
        TURN_URL?.let { url ->
            list.add(
                PeerConnection.IceServer.builder(url)
                    .setUsername(TURN_USER ?: "")
                    .setPassword(TURN_PASS ?: "")
                    .createIceServer()
            )
        }
        return list
    }

    /** تماس گرفتن */
    fun startCall(peer: Long, name: String, video: Boolean) {
        peerId = peer; wantVideo = video; isCaller = true
        callId = UUID.randomUUID().toString()
        _peerName.value = name
        _state.value = CallState.CALLING
        prepare(video)
        repo.callOffer(peer, callId, video)
    }

    /** پاسخ به تماس ورودی */
    fun answer(video: Boolean) {
        val incoming = repo.incomingCall.value ?: return
        peerId = incoming.optLong("from")
        _peerName.value = incoming.optString("fromName", "")
        callId = incoming.optString("callId")
        wantVideo = incoming.optBoolean("video", false) || video
        isCaller = false
        repo.incomingCall.value = null
        _state.value = CallState.CONNECTING
        prepare(wantVideo)
        /* پیشنهاد (offer) را همیشه تماس‌گیرنده می‌سازد، پس اینجا فقط اعلام آمادگی */
        repo.callSignal(peerId, callId, JSONObject().put("t", "accept"))
    }

    fun reject() {
        val incoming = repo.incomingCall.value
        if (incoming != null) {
            repo.callSignal(incoming.optLong("from"), incoming.optString("callId"), JSONObject().put("t", "reject"))
            repo.incomingCall.value = null
        }
        _state.value = CallState.IDLE
    }

    fun endCall() {
        if (peerId != 0L) repo.callSignal(peerId, callId, JSONObject().put("t", "end"))
        cleanup()
    }

    fun toggleMute(): Boolean {
        val s = localStream ?: return false
        s.audioTracks.firstOrNull()?.let { it.setEnabled(!it.enabled()); return !it.enabled() }
        return false
    }

    fun toggleCamera(): Boolean {
        val s = localStream ?: return false
        s.videoTracks.firstOrNull()?.let { it.setEnabled(!it.enabled()); return !it.enabled() }
        return false
    }

    fun attachLocal(renderer: SurfaceViewRenderer) {
        renderer.init(eglBase.eglBaseContext, null)
        localStream?.videoTracks?.firstOrNull()?.addSink(renderer)
    }

    fun attachRemote(renderer: SurfaceViewRenderer) {
        renderer.init(eglBase.eglBaseContext, null)
        remoteTrack?.addSink(renderer)
    }

    /* ───────── داخلی ───────── */

    private fun prepare(video: Boolean) {
        val rtc = PeerConnection.RTCConfiguration(iceServers()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        val peer = factory.createPeerConnection(rtc, object : PeerConnection.Observer {
            override fun onIceCandidate(c: IceCandidate) {
                repo.callSignal(peerId, callId, JSONObject().apply {
                    put("t", "signal")
                    put("ice", JSONObject().apply {
                        put("candidate", c.sdp); put("sdpMid", c.sdpMid); put("sdpMLineIndex", c.sdpMLineIndex)
                    })
                })
            }
            override fun onAddStream(stream: MediaStream) {
                remoteTrack = stream.videoTracks.firstOrNull()
                if (_state.value != CallState.CONNECTED) _state.value = CallState.CONNECTED
            }
            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                if (newState == PeerConnection.PeerConnectionState.CONNECTED) _state.value = CallState.CONNECTED
                if (newState == PeerConnection.PeerConnectionState.FAILED) cleanup()
            }
            override fun onSignalingChange(p0: PeerConnection.SignalingState?) {}
            override fun onIceConnectionChange(p0: PeerConnection.IceConnectionState?) {}
            override fun onIceConnectionReceivingChange(p0: Boolean) {}
            override fun onIceGatheringChange(p0: PeerConnection.IceGatheringState?) {}
            override fun onIceCandidatesRemoved(p0: Array<out IceCandidate>?) {}
            override fun onRemoveStream(p0: MediaStream?) {}
            override fun onDataChannel(p0: stream.webrtc.android.DataChannel?) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(p0: stream.webrtc.android.RtpReceiver?, p1: Array<out MediaStream>?) {}
        }) ?: return
        pc = peer

        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", if (video) "true" else "false"))
        }
        val stream = factory.createLocalMediaStream("jvl_local")
        stream.addTrack(factory.createAudioTrack("jvl_audio", factory.createAudioSource(MediaConstraints())))
        if (video) {
            val enumerator = Camera2Enumerator(context)
            val device = enumerator.deviceNames.firstOrNull { enumerator.isFrontFacing(it) } ?: enumerator.deviceNames.firstOrNull()
            device?.let {
                val capturer = enumerator.createCapturer(it, null)
                val source = factory.createVideoSource(capturer.isScreencast)
                capturer.initialize(stream.webrtc.android.SurfaceTextureHelper.create("jvl_capture", eglBase.eglBaseContext), context, source.capturerObserver)
                capturer.startCapture(1280, 720, 30)
                val track = factory.createVideoTrack("jvl_video", source)
                stream.addTrack(track)
            }
        }
        localStream = stream
        stream.audioTracks.forEach { peer.addTrack(it, listOf("jvl_local")) }
        stream.videoTracks.forEach { peer.addTrack(it, listOf("jvl_local")) }
    }

    private fun onSignal(json: JSONObject) {
        val peer = pc ?: return
        if (json.optLong("from") != peerId) return
        when (json.optString("t")) {
            "accept" -> {
                /* طرف مقابل آماده است؛ پیشنهاد را بساز و بفرست */
                val constraints = MediaConstraints().apply {
                    mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))
                    mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", wantVideo.toString()))
                }
                peer.createOffer(sdpObserver { sd ->
                    peer.setLocalDescription(simpleSdp(), sd)
                    repo.callSignal(peerId, callId, JSONObject().apply {
                        put("t", "signal"); put("sdp", JSONObject().apply {
                            put("type", sd.type.canonicalForm()); put("sdp", sd.description)
                        })
                    })
                }, constraints)
            }
            "signal" -> {
                json.optJSONObject("sdp")?.let { sdp ->
                    val type = if (sdp.optString("type") == "offer") SessionDescription.Type.OFFER else SessionDescription.Type.ANSWER
                    val desc = SessionDescription(type, sdp.optString("sdp"))
                    when (type) {
                        SessionDescription.Type.OFFER -> peer.setRemoteDescription(sdpObserver {
                            val constraints = MediaConstraints().apply {
                                mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))
                                mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", wantVideo.toString()))
                            }
                            peer.createAnswer(sdpObserver { ans ->
                                peer.setLocalDescription(simpleSdp(), ans)
                                repo.callSignal(peerId, callId, JSONObject().apply {
                                    put("t", "signal"); put("sdp", JSONObject().apply {
                                        put("type", ans.type.canonicalForm()); put("sdp", ans.description)
                                    })
                                })
                            }, constraints)
                        }, desc)
                        else -> peer.setRemoteDescription(simpleSdp(), desc)
                    }
                }
                json.optJSONObject("ice")?.let { ice ->
                    try {
                        peer.addIceCandidate(
                            IceCandidate(ice.optString("sdpMid"), ice.optInt("sdpMLineIndex"), ice.optString("candidate"))
                        )
                    } catch (_: Exception) {}
                }
            }
        }
    }

    private fun sdpObserver(onSuccess: (SessionDescription) -> Unit) = object : SdpObserver {
        override fun onCreateSuccess(sd: SessionDescription) = onSuccess(sd)
        override fun onSetSuccess() {}
        override fun onCreateFailure(p0: String?) {}
        override fun onSetFailure(p0: String?) {}
    }

    private fun simpleSdp() = object : SdpObserver {
        override fun onCreateSuccess(p0: SessionDescription?) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(p0: String?) {}
        override fun onSetFailure(p0: String?) {}
    }

    private fun cleanup() {
        try { pc?.close() } catch (_: Exception) {}
        try { localStream?.dispose() } catch (_: Exception) {}
        pc = null; localStream = null; remoteTrack = null
        peerId = 0; callId = ""
        _state.value = CallState.IDLE
        repo.incomingCall.value = null
    }
}
