package ir.javadxpro.volexturn.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import ir.javadxpro.volexturn.data.Repository
import ir.javadxpro.volexturn.data.User

/** فهرست کاربران (سمت راست، چون رابط راست‌به‌چپ است) */
@Composable
fun UserListScreen(repo: Repository, onOpen: (User) -> Unit) {
    val users by repo.users.collectAsState()
    val connected by repo.connected.collectAsState()

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                Modifier.size(9.dp).clip(RoundedCornerShape(50))
                    .background(if (connected) Color(0xFF10B981) else Color(0xFF6B7280))
            )
            Spacer(Modifier.width(6.dp))
            Text(
                if (connected) "متصل به شبکه" else "در حال اتصال…",
                style = MaterialTheme.typography.bodyMedium
            )
        }
        if (users.isEmpty()) {
            Text(
                "هنوز کسی اینجا نیست 🌱\nاز دستگاه‌های دیگر ثبت‌نام کنند تا دیده شوند",
                modifier = Modifier.padding(20.dp),
                style = MaterialTheme.typography.bodyMedium
            )
        }
        LazyColumn(Modifier.fillMaxSize()) {
            items(users, key = { it.id }) { u ->
                Row(
                    Modifier.fillMaxWidth().clickable { onOpen(u) }.padding(horizontal = 16.dp, vertical = 11.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Box(
                        Modifier.size(40.dp).clip(RoundedCornerShape(50))
                            .background(Primary.copy(alpha = 0.2f)),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(u.fullName.take(1), color = PrimaryLight, style = MaterialTheme.typography.titleLarge)
                    }
                    Spacer(Modifier.width(11.dp))
                    Column(Modifier.weight(1f)) {
                        Text(u.fullName, style = MaterialTheme.typography.labelLarge)
                        Text(
                            (if (u.online) "آنلاین" else "آفلاین") + " · @" + u.username,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f)
                        )
                    }
                    Box(
                        Modifier.size(9.dp).clip(RoundedCornerShape(50))
                            .background(if (u.online) Color(0xFF10B981) else Color(0xFF6B7280))
                    )
                }
                HorizontalDivider()
            }
        }
    }
}

/** گفتگوی دونفره */
@Composable
fun ChatScreen(repo: Repository, peer: User, onCall: (Boolean) -> Unit) {
    val messages by repo.messagesFlow.collectAsState()
    val me by repo.me.collectAsState()
    var draft by remember { mutableStateOf("") }

    LaunchedEffect(peer.id) {
        repo.selectedPeer = peer.id
        repo.markSeen(peer.id)
    }

    Column(Modifier.fillMaxSize()) {
        /* سربرگ گفتگو با دکمه‌های تماس */
        Row(
            Modifier.fillMaxWidth().padding(12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                Modifier.size(36.dp).clip(RoundedCornerShape(50)).background(Primary.copy(alpha = 0.2f)),
                contentAlignment = Alignment.Center
            ) { Text(peer.fullName.take(1), color = PrimaryLight) }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(peer.fullName, style = MaterialTheme.typography.labelLarge)
                Text(if (peer.online) "آنلاین" else "آفلاین", style = MaterialTheme.typography.bodyMedium)
            }
            IconButton(onClick = { onCall(false) }) { Icon(Icons.Default.Call, "تماس صوتی") }
            IconButton(onClick = { onCall(true) }) { Icon(Icons.Default.Videocam, "تماس تصویری") }
        }
        HorizontalDivider()

        LazyColumn(
            Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp),
            reverseLayout = true
        ) {
            items(messages.reversed(), key = { it.id }) { m ->
                val mine = m.senderId == me?.id
                Box(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    Surface(
                        modifier = Modifier.align(if (mine) Alignment.CenterEnd else Alignment.CenterStart),
                        shape = RoundedCornerShape(16.dp),
                        color = if (mine) Primary else MaterialTheme.colorScheme.surfaceVariant
                    ) {
                        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                            if (m.content.isNotEmpty()) {
                                Text(
                                    m.content,
                                    color = if (mine) Color.White else MaterialTheme.colorScheme.onSurface
                                )
                            }
                            if (m.media != null) {
                                Text(
                                    if (m.fileType == "image") "🖼 تصویر" else "📎 پیوست",
                                    style = MaterialTheme.typography.bodyMedium
                                )
                            }
                            Text(
                                m.timestamp.takeLast(8) + if (m.seen && mine) " ✓✓" else "",
                                style = MaterialTheme.typography.bodyMedium,
                                color = Color.White.copy(alpha = 0.6f)
                            )
                        }
                    }
                }
            }
        }

        Row(Modifier.fillMaxWidth().padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = draft, onValueChange = { draft = it },
                modifier = Modifier.weight(1f), placeholder = { Text("پیام…") }
            )
            Spacer(Modifier.width(8.dp))
            Button(
                onClick = {
                    val text = draft.trim()
                    if (text.isNotEmpty()) { repo.sendText(peer.id, text); draft = "" }
                },
                enabled = draft.isNotBlank()
            ) { Text("ارسال") }
        }
    }
}
