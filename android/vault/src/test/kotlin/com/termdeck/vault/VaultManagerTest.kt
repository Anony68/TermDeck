package com.termdeck.vault

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** In-memory server mimicking the real contract (auth + per-record LWW). */
private class FakeServer : Server {
    private class Acct(
        var authSecret: String,
        var recoveryAuthSecret: String,
        var account: AccountMaterial,
        var seq: Long = 0,
        val records: MutableMap<String, ServerRecord> = LinkedHashMap(),
    )
    private val byEmail = HashMap<String, Acct>()
    private val sessions = HashMap<String, String>() // token -> email
    private var tok = 0

    private fun newToken(email: String): String = "t${tok++}".also { sessions[it] = email }
    private fun acct(token: String) = byEmail[sessions[token] ?: error("bad token")]!!

    override fun register(email: String, authSecretHex: String, recoveryAuthSecretHex: String, account: AccountMaterial): String {
        require(email.lowercase() !in byEmail) { "email taken" }
        byEmail[email.lowercase()] = Acct(authSecretHex, recoveryAuthSecretHex, account)
        return newToken(email.lowercase())
    }
    override fun fetchMaterial(email: String): AccountMaterial = byEmail[email.lowercase()]!!.account
    override fun login(email: String, authSecretHex: String): LoginData {
        val a = byEmail[email.lowercase()] ?: error("no account")
        require(a.authSecret == authSecretHex) { "invalid credentials" }
        return LoginData(newToken(email.lowercase()), a.account)
    }
    override fun changePassword(token: String, newAuthSecretHex: String, account: AccountMaterial) {
        val a = acct(token); a.authSecret = newAuthSecretHex; a.account = account
    }
    override fun recoverComplete(email: String, recoveryAuthSecretHex: String, newAuthSecretHex: String, account: AccountMaterial): String {
        val a = byEmail[email.lowercase()] ?: error("no account")
        require(a.recoveryAuthSecret == recoveryAuthSecretHex) { "invalid recovery" }
        a.authSecret = newAuthSecretHex; a.account = account
        return newToken(email.lowercase())
    }
    override fun pull(token: String, since: Long): Pair<List<ServerRecord>, Long> {
        val a = acct(token)
        return a.records.values.filter { it.seq > since }.sortedBy { it.seq } to a.seq
    }
    override fun push(token: String, changes: List<ServerChange>): Long {
        val a = acct(token)
        for (c in changes) {
            a.seq += 1
            a.records[c.id] = ServerRecord(c.id, c.ciphertextHex, c.nonceHex, a.seq, c.deleted)
        }
        return a.seq
    }
}

class VaultManagerTest {
    private fun host(id: String, h: String) = Host(id = id, name = "n-$id", host = h, port = 22, user = "root", auth = "password")

    @Test fun twoDevicesShareVaultAndSecrets() {
        val srv = FakeServer()
        val a = VaultManager(srv)
        a.register("https://x", "me@x.com", "master-pass-123")
        a.upsertLocal(VaultEntry(host("h1", "1.1.1.1"), secret = "pw-one"))
        a.upsertLocal(VaultEntry(host("h2", "2.2.2.2"), secret = "pw-two"))
        a.sync()

        // A fresh device unlocks with the same password and sees both hosts + secrets.
        val b = VaultManager(srv)
        b.unlock("https://x", "me@x.com", "master-pass-123")
        b.sync()
        assertEquals(setOf("h1", "h2"), b.hosts().map { it.id }.toSet())
        assertEquals("pw-two", b.entry("h2")!!.secret)

        // Edit on B, delete on B, sync; A pulls the changes.
        b.upsertLocal(VaultEntry(host("h1", "9.9.9.9"), secret = "pw-one-edited"))
        b.deleteLocal("h2")
        b.sync()
        a.sync()
        assertEquals(listOf("h1"), a.hosts().map { it.id })
        assertEquals("9.9.9.9", a.entry("h1")!!.host.host)
        assertEquals("pw-one-edited", a.entry("h1")!!.secret)
    }

    @Test fun wrongPasswordFailsToUnlock() {
        val srv = FakeServer()
        VaultManager(srv).register("https://x", "u@x.com", "correct-pass-1")
        assertFailsWith<Exception> { VaultManager(srv).unlock("https://x", "u@x.com", "wrong-pass-9") }
    }

    @Test fun recoveryResetsPasswordKeepsData() {
        val srv = FakeServer()
        val a = VaultManager(srv)
        val code = a.register("https://x", "r@x.com", "old-master-123")
        a.upsertLocal(VaultEntry(host("h1", "1.1.1.1"), secret = "keepme"))
        a.sync()

        // Recover with the code + new password on a fresh device; data survives.
        val b = VaultManager(srv)
        b.recover("https://x", "r@x.com", code, "new-master-456")
        b.sync()
        assertEquals("keepme", b.entry("h1")!!.secret)

        // Old password no longer works; new one does.
        assertFailsWith<Exception> { VaultManager(srv).unlock("https://x", "r@x.com", "old-master-123") }
        val c = VaultManager(srv)
        c.unlock("https://x", "r@x.com", "new-master-456")
        assertTrue(c.isUnlocked)
    }

    @Test fun lockClearsState() {
        val srv = FakeServer()
        val a = VaultManager(srv)
        a.register("https://x", "l@x.com", "master-pass-123")
        a.upsertLocal(VaultEntry(host("h1", "1.1.1.1")))
        a.lock()
        assertTrue(!a.isUnlocked)
        assertNull(a.entry("h1"))
    }
}
