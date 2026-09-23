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

    /**
     * Cross-platform: a host pushed by the desktop actor (Rust `desktop-push` example) must
     * decrypt on Android. Runs only when SYNC_EMAIL/SYNC_PW (the desktop-created account)
     * are provided alongside the live URL.
     */
    @Test
    fun desktopVaultOpensOnAndroid() {
        val base = System.getenv("TERMDECK_LIVE_URL") ?: return
        val email = System.getenv("SYNC_EMAIL") ?: return
        val pw = System.getenv("SYNC_PW") ?: return
        val vm = VaultManager(OkHttpServer(base))
        vm.unlock(base, email, pw)
        vm.sync()
        val e = vm.entry("desk1")
        assertEquals("From Desktop", e!!.host.name)
        assertEquals("from-desktop-secret", e.secret)
    }
}
