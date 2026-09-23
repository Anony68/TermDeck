package com.termdeck.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.termdeck.vault.Host
import com.termdeck.vault.VaultEntry
import java.util.UUID

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    when (vm.screen) {
                        Screen.ACCOUNT -> AccountScreen(vm)
                        Screen.LIST -> HostListScreen(vm)
                        Screen.DETAIL -> HostDetailScreen(vm)
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AccountScreen(vm: AppViewModel) {
    var mode by remember { mutableStateOf(if (vm.hasAccount) "unlock" else "register") }
    var baseUrl by remember { mutableStateOf(vm.savedBaseUrl.ifEmpty { "https://" }) }
    var email by remember { mutableStateOf(vm.savedEmail) }
    var password by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }

    Column(Modifier.fillMaxSize().padding(20.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Spacer(Modifier.height(24.dp))
        Text("TermDeck", style = MaterialTheme.typography.headlineMedium)
        Text("Đồng bộ VPS mã hóa đầu-cuối", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(8.dp))

        if (vm.hasAccount && mode == "unlock") {
            Text("Mở khóa — ${vm.savedEmail}", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(password, { password = it }, label = { Text("Mật khẩu chính") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
            Button({ vm.unlock(vm.savedBaseUrl, vm.savedEmail, password) }, enabled = !vm.busy && password.isNotEmpty(), modifier = Modifier.fillMaxWidth()) { Text("Mở khóa") }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton({ mode = "recover" }) { Text("Khôi phục") }
                TextButton({ vm.signOut() }) { Text("Đăng xuất") }
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(mode == "register", { mode = "register" }, { Text("Đăng ký") })
                FilterChip(mode == "login", { mode = "login" }, { Text("Đăng nhập") })
                FilterChip(mode == "recover", { mode = "recover" }, { Text("Khôi phục") })
            }
            OutlinedTextField(baseUrl, { baseUrl = it }, label = { Text("Máy chủ đồng bộ") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(email, { email = it }, label = { Text("Email") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth())
            if (mode == "recover") OutlinedTextField(code, { code = it }, label = { Text("Mã khôi phục") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(password, { password = it }, label = { Text(if (mode == "recover") "Mật khẩu mới" else "Mật khẩu chính") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
            Button(
                onClick = {
                    when (mode) {
                        "register" -> vm.register(baseUrl, email, password)
                        "login" -> vm.unlock(baseUrl, email, password)
                        else -> vm.recover(baseUrl, email, code, password)
                    }
                },
                enabled = !vm.busy && baseUrl.isNotBlank() && email.isNotBlank() &&
                    password.length >= (if (mode == "register") 8 else 1) &&
                    (mode != "recover" || code.isNotBlank()),
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (mode == "register") "Đăng ký" else if (mode == "login") "Đăng nhập" else "Khôi phục") }
        }

        if (vm.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        vm.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }

    vm.recoveryCode?.let { rc ->
        AlertDialog(
            onDismissRequest = {},
            confirmButton = { TextButton({ vm.recoveryCode = null }) { Text("Tôi đã lưu mã") } },
            title = { Text("Mã khôi phục") },
            text = {
                Column {
                    Text("Lưu mã này ở nơi an toàn. Đây là cách DUY NHẤT lấy lại vault nếu quên mật khẩu chính.")
                    Spacer(Modifier.height(12.dp))
                    Text(rc, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
                }
            },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HostListScreen(vm: AppViewModel) {
    var adding by remember { mutableStateOf(false) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("VPS") },
                actions = {
                    IconButton({ vm.sync() }) { Icon(Icons.Filled.Sync, "Đồng bộ") }
                    IconButton({ vm.lock() }) { Icon(Icons.Filled.Lock, "Khóa") }
                },
            )
        },
        floatingActionButton = { FloatingActionButton({ adding = true }) { Icon(Icons.Filled.Add, "Thêm VPS") } },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            if (vm.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            vm.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }
            if (vm.hosts.isEmpty()) {
                Box(Modifier.fillMaxSize(), Alignment.Center) { Text("Chưa có VPS. Nhấn + để thêm.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            } else {
                LazyColumn(Modifier.fillMaxSize()) {
                    items(vm.hosts, key = { it.id }) { h ->
                        ListItem(
                            headlineContent = { Text(h.name.ifEmpty { "${h.user}@${h.host}" }) },
                            supportingContent = { Text("${h.user}@${h.host}:${h.port}") },
                            trailingContent = { IconButton({ vm.deleteHost(h.id) }) { Icon(Icons.Filled.Delete, "Xóa") } },
                            modifier = Modifier.clickable { vm.open(h.id) },
                        )
                        HorizontalDivider()
                    }
                }
            }
        }
    }
    if (adding) HostDialog(onDismiss = { adding = false }, onSave = { vm.saveHost(it); adding = false })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HostDialog(onDismiss: () -> Unit, onSave: (VaultEntry) -> Unit) {
    var name by remember { mutableStateOf("") }
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("22") }
    var user by remember { mutableStateOf("root") }
    var secret by remember { mutableStateOf("") }
    var remotePath by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(
                enabled = host.isNotBlank() && user.isNotBlank(),
                onClick = {
                    val h = Host(
                        id = UUID.randomUUID().toString(), name = name, host = host.trim(),
                        port = port.toIntOrNull() ?: 22, user = user.trim(), auth = "password",
                        remotePath = remotePath.ifBlank { null },
                    )
                    onSave(VaultEntry(h, secret = secret))
                },
            ) { Text("Lưu") }
        },
        dismissButton = { TextButton(onDismiss) { Text("Hủy") } },
        title = { Text("Thêm VPS") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(name, { name = it }, label = { Text("Tên") }, singleLine = true)
                OutlinedTextField(host, { host = it }, label = { Text("Host / IP") }, singleLine = true)
                OutlinedTextField(port, { port = it.filter(Char::isDigit) }, label = { Text("Port") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                OutlinedTextField(user, { user = it }, label = { Text("User") }, singleLine = true)
                OutlinedTextField(secret, { secret = it }, label = { Text("Mật khẩu") }, singleLine = true, visualTransformation = PasswordVisualTransformation())
                OutlinedTextField(remotePath, { remotePath = it }, label = { Text("Thư mục remote (tùy chọn)") }, singleLine = true)
            }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HostDetailScreen(vm: AppViewModel) {
    val entry = vm.selectedHostId?.let { vm.entry(it) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(entry?.host?.name?.ifEmpty { entry.host.host } ?: "VPS") },
                navigationIcon = { IconButton({ vm.back() }) { Icon(Icons.Filled.ArrowBack, "Quay lại") } },
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).padding(20.dp).fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            val h = entry?.host
            if (h != null) {
                Text("${h.user}@${h.host}:${h.port}", style = MaterialTheme.typography.titleMedium)
                if (!h.remotePath.isNullOrBlank()) Text("Thư mục: ${h.remotePath}")
                Spacer(Modifier.height(12.dp))
                ElevatedCard {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("Terminal SSH + SFTP", style = MaterialTheme.typography.titleSmall)
                        Text("Đang phát triển (SP3.4). VPS này đã đồng bộ và sẵn sàng kết nối.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            } else {
                Text("Không tìm thấy VPS.")
            }
        }
    }
}
