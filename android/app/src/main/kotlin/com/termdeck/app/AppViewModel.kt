package com.termdeck.app

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.viewModelScope
import com.termdeck.vault.AccountMaterial
import com.termdeck.vault.Host
import com.termdeck.vault.OkHttpServer
import com.termdeck.vault.VaultEntry
import com.termdeck.vault.VaultManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** Top-level screens. */
enum class Screen { ACCOUNT, LIST, DETAIL }

/** Holds the VaultManager and drives the UI. Network runs on IO; secrets stay in the VM. */
class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val prefs = app.getSharedPreferences("termdeck", 0)
    private var vm: VaultManager? = null

    var screen by mutableStateOf(Screen.ACCOUNT)
    var hosts by mutableStateOf<List<Host>>(emptyList())
    var selectedHostId by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var recoveryCode by mutableStateOf<String?>(null)
    var lastSyncAt by mutableStateOf<Long?>(null)

    /** True when an account is cached on this device (so we show Unlock, not Register). */
    val hasAccount: Boolean get() = prefs.contains("account")
    val savedBaseUrl: String get() = prefs.getString("baseUrl", "") ?: ""
    val savedEmail: String get() = prefs.getString("email", "") ?: ""
    val unlocked: Boolean get() = vm?.isUnlocked == true

    private fun cachedAccount(): AccountMaterial? {
        val s = prefs.getString("account", null) ?: return null
        val o = JSONObject(s)
        return AccountMaterial(
            o.getInt("kdfVersion"), o.getString("saltHex"), o.getString("protectedVkHex"),
            o.getString("protectedVkNonceHex"), o.getString("recoverySaltHex"),
            o.getString("recoveryProtectedVkHex"), o.getString("recoveryProtectedVkNonceHex"),
        )
    }

    private fun cacheAccount(baseUrl: String, email: String, a: AccountMaterial?) {
        prefs.edit().apply {
            putString("baseUrl", baseUrl)
            putString("email", email)
            if (a != null) putString("account", JSONObject()
                .put("kdfVersion", a.kdfVersion).put("saltHex", a.saltHex)
                .put("protectedVkHex", a.protectedVkHex).put("protectedVkNonceHex", a.protectedVkNonceHex)
                .put("recoverySaltHex", a.recoverySaltHex).put("recoveryProtectedVkHex", a.recoveryProtectedVkHex)
                .put("recoveryProtectedVkNonceHex", a.recoveryProtectedVkNonceHex).toString())
            apply()
        }
    }

    private fun run(block: suspend () -> Unit) {
        busy = true; error = null
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { block() }
            } catch (e: Exception) {
                error = e.message ?: e.toString()
            } finally {
                busy = false
            }
        }
    }

    private fun refresh() {
        hosts = vm?.hosts()?.sortedBy { it.name.ifEmpty { it.host } } ?: emptyList()
    }

    fun register(baseUrl: String, email: String, password: String) = run {
        val m = VaultManager(OkHttpServer(baseUrl)); vm = m
        val code = m.register(baseUrl, email, password)
        cacheAccount(baseUrl, email, m.account)
        m.sync(); lastSyncAt = System.currentTimeMillis()
        withContext(Dispatchers.Main) { recoveryCode = code; refresh(); screen = Screen.LIST }
    }

    fun unlock(baseUrl: String, email: String, password: String) = run {
        val m = VaultManager(OkHttpServer(baseUrl)); vm = m
        m.unlock(baseUrl, email, password, cachedAccount())
        cacheAccount(baseUrl, email, m.account)
        m.sync(); lastSyncAt = System.currentTimeMillis()
        withContext(Dispatchers.Main) { refresh(); screen = Screen.LIST }
    }

    fun recover(baseUrl: String, email: String, code: String, newPassword: String) = run {
        val m = VaultManager(OkHttpServer(baseUrl)); vm = m
        m.recover(baseUrl, email, code, newPassword)
        cacheAccount(baseUrl, email, m.account)
        m.sync(); lastSyncAt = System.currentTimeMillis()
        withContext(Dispatchers.Main) { refresh(); screen = Screen.LIST }
    }

    fun sync() = run {
        vm?.sync(); lastSyncAt = System.currentTimeMillis()
        withContext(Dispatchers.Main) { refresh() }
    }

    fun saveHost(entry: VaultEntry) = run {
        vm?.upsertLocal(entry); vm?.sync(); lastSyncAt = System.currentTimeMillis()
        withContext(Dispatchers.Main) { refresh() }
    }

    fun deleteHost(id: String) = run {
        vm?.deleteLocal(id); vm?.sync()
        withContext(Dispatchers.Main) { refresh(); if (selectedHostId == id) { selectedHostId = null; screen = Screen.LIST } }
    }

    fun entry(id: String): VaultEntry? = vm?.entry(id)

    fun lock() {
        vm?.lock(); vm = null; hosts = emptyList(); screen = Screen.ACCOUNT
    }

    fun signOut() {
        prefs.edit().clear().apply()
        lock()
    }

    fun open(id: String) { selectedHostId = id; screen = Screen.DETAIL }
    fun back() { screen = Screen.LIST }
}
