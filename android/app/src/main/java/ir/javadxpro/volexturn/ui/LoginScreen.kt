package ir.javadxpro.volexturn.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import ir.javadxpro.volexturn.R
import ir.javadxpro.volexturn.data.Repository

@Composable
fun LoginScreen(repo: Repository, onLoggedIn: () -> Unit) {
    var mode by remember { mutableStateOf("login") }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Surface(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier.fillMaxSize().padding(28.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text("Volexturn", style = MaterialTheme.typography.titleLarge, color = Primary)
            Spacer(Modifier.height(4.dp))
            Text("شبکهٔ محلی، بدون سرور", style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(28.dp))

            OutlinedTextField(
                value = username, onValueChange = { username = it },
                label = { Text(stringResource(R.string.username)) },
                singleLine = true, modifier = Modifier.fillMaxWidth()
            )
            Spacer(Modifier.height(10.dp))
            OutlinedTextField(
                value = password, onValueChange = { password = it },
                label = { Text(stringResource(R.string.password)) },
                singleLine = true, visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Password),
                modifier = Modifier.fillMaxWidth()
            )
            if (error != null) {
                Spacer(Modifier.height(8.dp))
                Text(error!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            }
            Spacer(Modifier.height(18.dp))
            Button(
                onClick = {
                    busy = true; error = null
                    scope.launchWhenStarted {
                        val res = if (mode == "login") repo.login(username, password) else repo.register(username, password)
                        busy = false
                        res.onSuccess {
                            repo.sessionStarted(it)
                            onLoggedIn()
                        }.onFailure { e -> error = e.message }
                    }
                },
                enabled = !busy && username.isNotBlank() && password.isNotBlank(),
                modifier = Modifier.fillMaxWidth().height(48.dp)
            ) {
                Text(if (mode == "login") stringResource(R.string.login) else stringResource(R.string.register))
            }
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = { mode = if (mode == "login") "register" else "login" }) {
                Text(if (mode == "login") "حساب نداری؟ ثبت‌نام کن" : "حساب داری؟ وارد شو")
            }
        }
    }
}
