package ir.javadxpro.volexturn.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import ir.javadxpro.volexturn.R
import ir.javadxpro.volexturn.contacts.ContactSync
import ir.javadxpro.volexturn.data.ContactMatch
import ir.javadxpro.volexturn.data.Repository

/**
 * همسان‌سازی مخاطبین: شماره‌ها روی دستگاه خوانده و هش می‌شوند؛ فقط هش‌ها
 * با کشِ محلیِ تاپیک‌های phone/… مقایسه می‌شوند. شمارهٔ خام بیرون نمی‌رود.
 */
@Composable
fun ContactsScreen(repo: Repository, onOpen: (Long) -> Unit) {
    val context = LocalContext.current
    var myPhone by remember { mutableStateOf("") }
    var matches by remember { mutableStateOf<List<ContactMatch>>(emptyList()) }
    var checked by remember { mutableStateOf(0) }
    var message by remember { mutableStateOf<String?>(null) }

    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) { message = "بدون دسترسی به مخاطبین نمی‌شود همسان‌سازی کرد"; return@rememberLauncherForActivityResult }
        val list = ContactSync.read(context)
        checked = list.size
        matches = repo.lookupContacts(list.map { it.phone })
        message = if (matches.isEmpty()) "هیچ‌کدام از این شماره‌ها روی پلتفرم نیستند" else null
    }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text(stringResource(R.string.sync_contacts), style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(6.dp))
        Text(
            "فقط هشِ شماره‌ها مقایسه می‌شود و شمارهٔ خام از دستگاه بیرون نمی‌رود.",
            style = MaterialTheme.typography.bodyMedium
        )
        Spacer(Modifier.height(14.dp))

        OutlinedTextField(
            value = myPhone, onValueChange = { myPhone = it },
            label = { Text(stringResource(R.string.my_phone)) },
            singleLine = true, modifier = Modifier.fillMaxWidth()
        )
        Spacer(Modifier.height(8.dp))
        Button(
            onClick = {
                message = if (repo.setMyPhone(myPhone)) "شماره‌ات ثبت شد ✅" else "شماره معتبر نیست"
            },
            enabled = myPhone.isNotBlank()
        ) { Text("ثبت شمارهٔ من") }

        Spacer(Modifier.height(10.dp))
        Button(onClick = {
            val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) ==
                PackageManager.PERMISSION_GRANTED
            if (granted) permission.launch(Manifest.permission.READ_CONTACTS) else permission.launch(Manifest.permission.READ_CONTACTS)
        }) { Text(stringResource(R.string.sync_contacts)) }

        message?.let {
            Spacer(Modifier.height(10.dp))
            Text(it, style = MaterialTheme.typography.bodyMedium)
        }
        if (checked > 0) {
            Spacer(Modifier.height(6.dp))
            Text("$checked شماره بررسی شد، ${matches.size} مورد روی پلتفرم بود")
        }

        Spacer(Modifier.height(12.dp))
        LazyColumn {
            items(matches, key = { it.user.id }) { m ->
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text(m.user.fullName, style = MaterialTheme.typography.labelLarge)
                        Text("@" + m.user.username, style = MaterialTheme.typography.bodyMedium)
                    }
                    TextButton(onClick = { onOpen(m.user.id) }) { Text("گفتگو") }
                }
                HorizontalDivider()
            }
        }
    }
}
