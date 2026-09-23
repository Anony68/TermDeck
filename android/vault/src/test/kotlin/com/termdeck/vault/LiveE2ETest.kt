package com.termdeck.vault

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Real end-to-end against a deployed sync server (real Argon2/XChaCha20 crypto → live HTTP
 * API → pull → decrypt). Opt-in: only runs when TERMDECK_LIVE_URL is set, so the normal
 * unit-test run stays offline.
 */
class LiveE2ETest {
    @Test
    fun registerPushThenUnlockPullOnFreshManager() {
        val base = System.getenv("TERMDECK_LIVE_URL") ?: return // skip when not set
        val email = "e2e-${System.currentTimeMillis()}@x.com"
        val pw = "master-pass-e2e-123"

        val a = VaultManager(OkHttpServer(base))
        a.register(base, email, pw)
        a.upsertLocal(VaultEntry(Host("h1", "prod", "10.0.0.1", 22, "root", "password"), secret = "s3cr3t-pw"))
        a.sync()

        // A fresh manager (simulating another device) unlocks + pulls the encrypted record
        // and must recover the plaintext secret — proving the full pipeline over the wire.
        val b = VaultManager(OkHttpServer(base))
        b.unlock(base, email, pw)
        b.sync()
        assertEquals(listOf("h1"), b.hosts().map { it.id })
        assertEquals("s3cr3t-pw", b.entry("h1")!!.secret)
        assertTrue(b.isUnlocked)
    }
}
