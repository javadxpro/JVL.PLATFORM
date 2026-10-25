package ir.javadxpro.volexturn

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.LayoutDirection
import androidx.core.content.ContextCompat
import ir.javadxpro.volexturn.call.CallState
import ir.javadxpro.volexturn.service.BrokerService
import ir.javadxpro.volexturn.ui.*

/**
 * رابط بومی (Compose، راست‌به‌چپ). همان الگوی کلاینت وب: همهٔ بخش‌ها
 * در نوار بالا هستند و تماس با WebRTC روی MQTT سیگنال می‌شود.
 */
class MainActivity : ComponentActivity() {

    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val app = application as VolexturnApp
        val needed = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            add(Manifest.permission.CAMERA)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
        }.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (needed.isNotEmpty()) permissions.launch(needed.toTypedArray())
        BrokerService.start(this)

        setContent {
            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                VolexturnTheme { Root(app) }
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        if (isFinishing) (application as VolexturnApp).repo.publishPresence(false)
    }
}

@Composable
private fun Root(app: VolexturnApp) {
    val repo = app.repo
    val calls = app.calls
    val me by repo.me.collectAsState()
    val callState by calls.state.collectAsState()
    val incoming by repo.incomingCall.collectAsState()
    var tab by remember { mutableStateOf("chats") }
    var peer by remember { mutableStateOf<ir.javadxpro.volexturn.data.User?>(null) }

    if (me == null) {
        LoginScreen(repo) { /* ورود انجام شد */ }
        IncomingCallDialog(app)
        return
    }

    /* تماس فعال روی همهٔ بخش‌ها می‌نشیند */
    if (callState == CallState.CONNECTED || callState == CallState.CONNECTING || callState == CallState.CALLING) {
        CallScreen(calls)
        IncomingCallDialog(app)
        return
    }

    Scaffold(
        topBar = {
            Column {
                TopAppBar(
                    title = { Text("Volexturn") },
                    navigationIcon = {
                        Text(
                            "☰",
                            modifier = Modifier.padding(horizontal = 16.dp)
                        )
                    }
                )
                /* همهٔ بخش‌ها در نوار بالا — مثل کلاینت وب */
                ScrollableTabRow(
                    selectedTabIndex = when (tab) { "chats" -> 0; "contacts" -> 1; else -> 2 },
                    edgePadding = 8.dp
                ) {
                    Tab(selected = tab == "chats", onClick = { tab = "chats"; peer = null }, text = { Text(stringResource(R.string.chats)) })
                    Tab(selected = tab == "contacts", onClick = { tab = "contacts" }, text = { Text(stringResource(R.string.contacts)) })
                    Tab(selected = tab == "profile", onClick = { tab = "profile" }, text = { Text(stringResource(R.string.profile)) })
                }
            }
        }
    ) { padding ->
        Box(Modifier.padding(padding)) {
            when (tab) {
                "chats" -> if (peer == null) UserListScreen(repo) { peer = it }
                else ChatScreen(repo, peer!!) { video -> calls.startCall(peer!!.id, peer!!.fullName, video) }
                "contacts" -> ContactsScreen(repo) { id ->
                    repo.findUser(id)?.let { peer = it; tab = "chats" }
                }
                else -> ProfileScreen(repo)
            }
        }
    }

    IncomingCallDialog(app)
}

/** پنجرهٔ تماس ورودی */
@Composable
private fun IncomingCallDialog(app: VolexturnApp) {
    val incoming by app.repo.incomingCall.collectAsState()
    if (incoming == null) return
    AlertDialog(
        onDismissRequest = { app.calls.reject() },
        title = { Text(stringResource(R.string.incoming_call)) },
        text = { Text(incoming?.optString("fromName", "") ?: "") },
        confirmButton = {
            Button(onClick = { app.calls.answer(incoming!!.optBoolean("video", false)) }) {
                Text(stringResource(R.string.answer))
            }
        },
        dismissButton = {
            OutlinedButton(onClick = { app.calls.reject() }) { Text(stringResource(R.string.reject)) }
        }
    )
}

@Composable
private fun ProfileScreen(repo: ir.javadxpro.volexturn.data.Repository) {
    val me by repo.me.collectAsState()
    val u = me ?: return
    Column(Modifier.fillMaxSize().padding(18.dp)) {
        Text(u.fullName, style = MaterialTheme.typography.titleLarge)
        Text("@" + u.username, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(10.dp))
        Text("نقش: " + u.role, style = MaterialTheme.typography.bodyMedium)
        Text("عضو از: " + u.createdAt, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(14.dp))
        Text(
            "اتصال روی MQTT عمومی است و هیچ داده‌ای ذخیره نمی‌شود؛ با بستن اپ همه‌چیز می‌رود.",
            style = MaterialTheme.typography.bodyMedium
        )
    }
}
