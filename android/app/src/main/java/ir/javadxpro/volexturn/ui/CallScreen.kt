package ir.javadxpro.volexturn.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import ir.javadxpro.volexturn.R
import ir.javadxpro.volexturn.call.CallManager
import ir.javadxpro.volexturn.call.CallState
import stream.webrtc.android.RendererCommon
import stream.webrtc.android.SurfaceViewRenderer

@Composable
fun CallScreen(calls: CallManager) {
    val state by calls.state.collectAsState()
    val name by calls.peerName.collectAsState()
    val context = LocalContext.current

    Box(Modifier.fillMaxSize().background(Color(0xFF070A12))) {
        AndroidView(
            factory = { ctx ->
                SurfaceViewRenderer(ctx).apply {
                    setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
                    calls.attachRemote(this)
                }
            },
            modifier = Modifier.fillMaxSize()
        )
        AndroidView(
            factory = { ctx ->
                SurfaceViewRenderer(ctx).apply {
                    setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
                    calls.attachLocal(this)
                }
            },
            modifier = Modifier
                .padding(top = 28.dp, start = 16.dp)
                .width(104.dp).height(150.dp)
                .clip(androidx.compose.foundation.shape.RoundedCornerShape(14.dp))
        )

        Column(
            modifier = Modifier.align(Alignment.TopCenter).padding(top = 56.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(name, color = Color.White, style = MaterialTheme.typography.titleLarge)
            Text(
                when (state) {
                    CallState.CALLING -> "در حال تماس…"
                    CallState.CONNECTING -> stringResource(R.string.connecting)
                    CallState.CONNECTED -> "متصل شد"
                    else -> ""
                },
                color = Color.White.copy(alpha = 0.7f), style = MaterialTheme.typography.bodyMedium
            )
        }

        Row(
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 36.dp),
            horizontalArrangement = Arrangement.spacedBy(18.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            CallButton(MaterialTheme.colorScheme.surfaceVariant) { calls.toggleMute() }
            CallButton(MaterialTheme.colorScheme.surfaceVariant) { calls.toggleCamera() }
            CallButton(Color(0xFFEF4444), size = 66) { calls.endCall() }
        }
    }
}

@Composable
private fun CallButton(bg: Color, size: Int = 56, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(size.dp)
            .clip(CircleShape)
            .background(bg)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        Icon(
            imageVector = Icons.Default.Call,
            contentDescription = null,
            tint = Color.White
        )
    }
}
