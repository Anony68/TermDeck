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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.termdeck.vault.Host
import com.termdeck.vault.VaultEntry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    Column(Modifier.fillMaxSize()) {
                        Box(Modifier.weight(1f).fillMaxWidth()) {
                            when (vm.screen) {
                                Screen.ACCOUNT -> AccountScreen(vm)
                                Screen.LIST -> HostListScreen(vm)
                                Screen.DETAIL -> HostDetailScreen(vm)
                            }
                        }
                        VersionBar()
                    }
                }
            }
        }
    }
}

@Composable
private fun VersionBar() {
    Text(
        "TermDeck v${BuildConfig.VERSION_NAME} · ${BuildConfig.BUILD_TAG} · $sshCryptoDiag",
        Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        fontSize = 10.sp,
        fontFamily = FontFamily.Monospace,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AccountScreen(vm: AppViewModel) {
    var mode by remember { mutableStateOf(if (vm.hasAccount) "unlock" else "register") }
    var baseUrl by remember { mutableStateOf(vm.savedBaseUrl.ifEmpty { "https://termdeck-sync.block-blash.workers.dev" }) }
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
    val h = entry?.host
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var tab by remember { mutableStateOf(0) }
    var conn by remember { mutableStateOf("connecting") } // connecting | ready | error
    var connErr by remember { mutableStateOf<String?>(null) }
    val session = remember { mutableStateOf<SshSession?>(null) }

    // Connect once per host; disconnect on leave.
    DisposableEffect(vm.selectedHostId) {
        if (h != null && entry != null) {
            scope.launch {
                try {
                    val s = SshSession(h, entry.secret, entry.keyContent, ctx.getSharedPreferences("termdeck_knownhosts", 0))
                    withContext(Dispatchers.IO) { s.connect() }
                    session.value = s
                    conn = "ready"
                } catch (e: Exception) {
                    connErr = e.message ?: e.toString(); conn = "error"
                }
            }
        }
        onDispose { session.value?.let { s -> scope.launch(Dispatchers.IO) { s.close() } } }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(h?.name?.ifEmpty { h.host } ?: "VPS") },
                navigationIcon = { IconButton({ vm.back() }) { Icon(Icons.Filled.ArrowBack, "Quay lại") } },
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            if (h == null) { Text("Không tìm thấy VPS.", Modifier.padding(20.dp)); return@Column }
            TabRow(selectedTabIndex = tab) {
                Tab(tab == 0, { tab = 0 }, text = { Text("Terminal") })
                Tab(tab == 1, { tab = 1 }, text = { Text("Tệp (SFTP)") })
            }
            when (conn) {
                "connecting" -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
                "error" -> Box(Modifier.fillMaxSize(), Alignment.Center) { Text("Lỗi kết nối: $connErr", color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }
                else -> {
                    val s = session.value!!
                    if (tab == 0) TerminalTab(s) else FilesTab(s, h.remotePath?.ifBlank { null })
                }
            }
        }
    }
}

@Composable
private fun TerminalTab(session: SshSession) {
    var output by remember { mutableStateOf("") }
    var input by remember { mutableStateOf("") }
    val scroll = rememberScrollState()
    val scope = rememberCoroutineScope()

    LaunchedEffect(session) {
        withContext(Dispatchers.IO) {
            runCatching { session.openShell { chunk -> output = (output + chunk).takeLast(40000) } }
        }
    }
    LaunchedEffect(output) { scroll.animateScrollTo(scroll.maxValue) }

    Column(Modifier.fillMaxSize()) {
        Text(
            output.ifEmpty { "Đang mở shell…" },
            Modifier.weight(1f).fillMaxWidth().verticalScroll(scroll).padding(10.dp),
            fontFamily = FontFamily.Monospace, fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                input, { input = it }, Modifier.weight(1f),
                placeholder = { Text("Lệnh…") }, singleLine = true,
                textStyle = androidx.compose.ui.text.TextStyle(fontFamily = FontFamily.Monospace),
            )
            IconButton({ scope.launch(Dispatchers.IO) { session.send(input + "\n") }; input = "" }) {
                Icon(Icons.Filled.Send, "Gửi")
            }
        }
    }
}

@Composable
private fun FilesTab(session: SshSession, startDir: String?) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var path by remember { mutableStateOf(startDir ?: "") }
    var entries by remember { mutableStateOf<List<SftpEntry>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var msg by remember { mutableStateOf<String?>(null) }

    fun load(p: String) {
        loading = true; msg = null
        scope.launch {
            try {
                val dir = withContext(Dispatchers.IO) { if (p.isBlank()) session.homeDir() else p }
                val list = withContext(Dispatchers.IO) { session.list(dir) }
                path = dir; entries = list
            } catch (e: Exception) { msg = e.message } finally { loading = false }
        }
    }
    LaunchedEffect(Unit) { load(startDir ?: "") }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton({ if (path.length > 1) load(path.substringBeforeLast('/').ifEmpty { "/" }) }) { Icon(Icons.Filled.ArrowUpward, "Lên") }
            Text(path, Modifier.weight(1f), fontFamily = FontFamily.Monospace, fontSize = 12.sp, maxLines = 1)
            IconButton({ load(path) }) { Icon(Icons.Filled.Refresh, "Tải lại") }
        }
        msg?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 12.dp)) }
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        LazyColumn(Modifier.fillMaxSize()) {
            items(entries, key = { it.path }) { e ->
                ListItem(
                    headlineContent = { Text(e.name) },
                    supportingContent = { if (!e.isDir) Text("${e.size} B") },
                    leadingContent = { Icon(if (e.isDir) Icons.Filled.Folder else Icons.Filled.InsertDriveFile, null) },
                    modifier = Modifier.clickable {
                        if (e.isDir) load(e.path)
                        else scope.launch {
                            try {
                                val f = withContext(Dispatchers.IO) { session.download(e.path, e.name, ctx.cacheDir) }
                                msg = "Đã tải: ${f.absolutePath}"
                            } catch (ex: Exception) { msg = ex.message }
                        }
                    },
                )
                HorizontalDivider()
            }
        }
    }
}
