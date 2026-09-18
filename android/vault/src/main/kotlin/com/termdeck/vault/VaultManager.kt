package com.termdeck.vault

import org.json.JSONObject
import java.security.SecureRandom

/**
 * Android-side E2EE vault: holds the vault key + decrypted entries in memory while unlocked,
 * and syncs encrypted records with the [Server]. Mirrors the desktop `cloud.rs` behavior so
 * the two stay interoperable. Unlike desktop (which keeps secrets in the OS keyring), Android
 * keeps decrypted secrets in this manager's memory while unlocked.
 */
class VaultManager(private val server: Server) {
    private val rng = SecureRandom()

    var baseUrl: String = ""; private set
    var email: String = ""; private set
    var account: AccountMaterial? = null; private set
    private var token: String? = null
    private var vk: ByteArray? = null

    private val entries = LinkedHashMap<String, VaultEntry>()
    private val dirty = LinkedHashSet<String>()
    private val deletes = LinkedHashSet<String>()
    var cursor: Long = 0; private set

    val isUnlocked: Boolean get() = vk != null
    fun hosts(): List<Host> = entries.values.map { it.host }
    fun entry(id: String): VaultEntry? = entries[id]

    private fun rand(n: Int) = ByteArray(n).also { rng.nextBytes(it) }

    /** Register a new account; returns the one-time recovery code to show the user. */
    fun register(baseUrl: String, email: String, masterPassword: String): String {
        val vkLocal = rand(32)
        // Recovery: code -> key -> wrap VK + auth secret.
        val code = formatRecoveryCode(rand(20))
        val recSalt = rand(16)
        val recKey = Crypto.deriveRecoveryKey(code, recSalt)
        val recNonce = rand(24)
        val recWrap = Crypto.seal(recKey, recNonce, vkLocal)
        val recoveryAuthSecret = Crypto.hex(Crypto.deriveAuthSecret(recKey))

        val (acct, authSecretHex) = buildAccount(masterPassword, vkLocal, Crypto.hex(recSalt), Crypto.hex(recWrap), Crypto.hex(recNonce))
        val tok = server.register(email, authSecretHex, recoveryAuthSecret, acct)

        this.baseUrl = baseUrl; this.email = email; this.account = acct; this.token = tok; this.vk = vkLocal
        dirty.clear(); deletes.clear(); cursor = 0
        return code
    }

    /** Unlock with the master password (+ optional cached material), then obtain a token. */
    fun unlock(baseUrl: String, email: String, masterPassword: String, cached: AccountMaterial? = null) {
        val acct = cached ?: server.fetchMaterial(email)
        val masterKey = Crypto.deriveMasterKey(masterPassword, Crypto.unhex(acct.saltHex))
        val kek = Crypto.deriveKek(masterKey)
        val vkLocal = Crypto.open(kek, Crypto.unhex(acct.protectedVkNonceHex), Crypto.unhex(acct.protectedVkHex))
        val login = server.login(email, Crypto.hex(Crypto.deriveAuthSecret(masterKey)))
        this.baseUrl = baseUrl; this.email = email; this.account = login.account; this.token = login.token; this.vk = vkLocal
    }

    /** Recover with the recovery code and set a new master password. */
    fun recover(baseUrl: String, email: String, recoveryCode: String, newMasterPassword: String) {
        val material = server.fetchMaterial(email)
        val recKey = Crypto.deriveRecoveryKey(recoveryCode, Crypto.unhex(material.recoverySaltHex))
        val vkLocal = Crypto.open(recKey, Crypto.unhex(material.recoveryProtectedVkNonceHex), Crypto.unhex(material.recoveryProtectedVkHex))
        val recoveryAuthSecret = Crypto.hex(Crypto.deriveAuthSecret(recKey))
        val (acct, authSecretHex) = buildAccount(newMasterPassword, vkLocal, material.recoverySaltHex, material.recoveryProtectedVkHex, material.recoveryProtectedVkNonceHex)
        val tok = server.recoverComplete(email, recoveryAuthSecret, authSecretHex, acct)
        this.baseUrl = baseUrl; this.email = email; this.account = acct; this.token = tok; this.vk = vkLocal
    }

    fun changePassword(newMasterPassword: String) {
        val vkLocal = vk ?: error("locked")
        val a = account ?: error("no account")
        val (acct, authSecretHex) = buildAccount(newMasterPassword, vkLocal, a.recoverySaltHex, a.recoveryProtectedVkHex, a.recoveryProtectedVkNonceHex)
        server.changePassword(token ?: error("no token"), authSecretHex, acct)
        this.account = acct
    }

    fun lock() {
        vk?.fill(0)
        vk = null; token = null
        entries.clear(); dirty.clear(); deletes.clear()
    }

    // ---- local edits ----
    fun upsertLocal(entry: VaultEntry) {
        entries[entry.host.id] = entry
        dirty += entry.host.id
        deletes -= entry.host.id
    }
    fun deleteLocal(id: String) {
        entries.remove(id)
        deletes += id
        dirty -= id
    }

    /** Push local changes, then pull remote ones and merge (LWW by server seq). */
    fun sync() {
        val key = vk ?: error("locked")
        val tok = token ?: error("not signed in")
        val changes = ArrayList<ServerChange>()
        for (id in dirty) {
            val e = entries[id] ?: continue
            val nonce = rand(24)
            val ct = Crypto.seal(key, nonce, entryPlaintext(e).toByteArray(Charsets.UTF_8))
            changes += ServerChange(id, Crypto.hex(ct), Crypto.hex(nonce), false)
        }
        for (id in deletes) changes += ServerChange(id, "", "", true)
        if (changes.isNotEmpty()) server.push(tok, changes)

        val (records, newCursor) = server.pull(tok, cursor)
        for (r in records) {
            if (r.deleted) { entries.remove(r.id); continue }
            val pt = Crypto.open(key, Crypto.unhex(r.nonceHex), Crypto.unhex(r.ciphertextHex)).toString(Charsets.UTF_8)
            entries[r.id] = parseEntry(pt)
        }
        cursor = newCursor
        dirty.clear(); deletes.clear()
    }

    // ---- helpers ----

    private fun buildAccount(masterPassword: String, vk: ByteArray, recSaltHex: String, recWrapHex: String, recNonceHex: String): Pair<AccountMaterial, String> {
        val salt = rand(16)
        val masterKey = Crypto.deriveMasterKey(masterPassword, salt)
        val kek = Crypto.deriveKek(masterKey)
        val nonce = rand(24)
        val protectedVk = Crypto.seal(kek, nonce, vk)
        val acct = AccountMaterial(
            kdfVersion = 1,
            saltHex = Crypto.hex(salt),
            protectedVkHex = Crypto.hex(protectedVk),
            protectedVkNonceHex = Crypto.hex(nonce),
            recoverySaltHex = recSaltHex,
            recoveryProtectedVkHex = recWrapHex,
            recoveryProtectedVkNonceHex = recNonceHex,
        )
        return acct to Crypto.hex(Crypto.deriveAuthSecret(masterKey))
    }

    private fun entryPlaintext(e: VaultEntry): String =
        JSONObject().put("host", hostToJson(e.host)).put("secret", e.secret).put("keyContent", e.keyContent).toString()

    private fun parseEntry(pt: String): VaultEntry {
        val o = JSONObject(pt)
        return VaultEntry(hostFromJson(o.getJSONObject("host")), o.optString("secret"), o.optString("keyContent"))
    }

    private fun hostToJson(h: Host) = JSONObject()
        .put("id", h.id).put("name", h.name).put("host", h.host).put("port", h.port)
        .put("user", h.user).put("auth", h.auth)
        .put("keyPath", h.keyPath ?: JSONObject.NULL)
        .put("remotePath", h.remotePath ?: JSONObject.NULL)
        .put("presetCommand", h.presetCommand ?: JSONObject.NULL)

    private fun hostFromJson(o: JSONObject) = Host(
        id = o.getString("id"), name = o.optString("name"),
        host = o.getString("host"), port = o.optInt("port", 22), user = o.optString("user"),
        auth = if (o.optString("auth") == "key") "key" else "password",
        keyPath = o.optString("keyPath").ifEmpty { null }?.takeIf { it != "null" },
        remotePath = o.optString("remotePath").ifEmpty { null }?.takeIf { it != "null" },
        presetCommand = o.optString("presetCommand").ifEmpty { null }?.takeIf { it != "null" },
    )

    /** Base32 (RFC4648, no padding), grouped in 4s with dashes — matches the Rust formatter. */
    private fun formatRecoveryCode(raw: ByteArray): String {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        val sb = StringBuilder()
        var buffer = 0
        var bits = 0
        for (b in raw) {
            buffer = (buffer shl 8) or (b.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                bits -= 5
                sb.append(alphabet[(buffer ushr bits) and 0x1f])
            }
        }
        if (bits > 0) sb.append(alphabet[(buffer shl (5 - bits)) and 0x1f])
        return sb.toString().chunked(4).joinToString("-")
    }
}
