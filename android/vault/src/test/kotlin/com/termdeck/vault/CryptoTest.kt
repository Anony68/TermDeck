package com.termdeck.vault

import org.json.JSONObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * Cross-language contract: every output must match the Rust `vault-crypto` reference in
 * `test-vectors.json`. If this passes, a vault encrypted on desktop decrypts on Android.
 */
class CryptoTest {
    private val v: JSONObject = JSONObject(
        this::class.java.getResourceAsStream("/test-vectors.json")!!.readBytes().decodeToString()
    )
    private fun h(k: String) = Crypto.unhex(v.getString(k))

    @Test fun masterKeyMatches() {
        val mk = Crypto.deriveMasterKey(v.getString("password"), h("salt_hex"))
        assertEquals(v.getString("master_key_hex"), Crypto.hex(mk))
    }

    @Test fun kekAndAuthMatch() {
        val mk = Crypto.deriveMasterKey(v.getString("password"), h("salt_hex"))
        assertEquals(v.getString("kek_hex"), Crypto.hex(Crypto.deriveKek(mk)))
        assertEquals(v.getString("auth_secret_hex"), Crypto.hex(Crypto.deriveAuthSecret(mk)))
    }

    @Test fun protectedVkEncryptsAndDecrypts() {
        val kek = h("kek_hex")
        val vk = h("vk_hex")
        val nonce = h("kek_nonce_hex")
        // Deterministic encrypt must reproduce Rust's ciphertext byte-for-byte.
        assertEquals(v.getString("protected_vk_hex"), Crypto.hex(Crypto.seal(kek, nonce, vk)))
        // And decrypt round-trips back to VK.
        assertEquals(v.getString("vk_hex"), Crypto.hex(Crypto.open(kek, nonce, Crypto.seal(kek, nonce, vk))))
    }

    @Test fun recordEncryptsToRustCiphertext() {
        val vk = h("vk_hex")
        val nonce = h("record_nonce_hex")
        val pt = v.getString("record_plaintext").toByteArray(Charsets.UTF_8)
        assertEquals(v.getString("record_ciphertext_hex"), Crypto.hex(Crypto.seal(vk, nonce, pt)))
    }

    @Test fun recoveryKeyAndWrapMatch() {
        val recKey = Crypto.deriveRecoveryKey(v.getString("recovery_code"), h("recovery_salt_hex"))
        assertEquals(v.getString("recovery_key_hex"), Crypto.hex(recKey))
        assertEquals(
            v.getString("recovery_protected_vk_hex"),
            Crypto.hex(Crypto.seal(recKey, h("kek_nonce_hex"), h("vk_hex")))
        )
    }

    @Test fun tamperedCiphertextRejected() {
        val vk = h("vk_hex")
        val nonce = h("record_nonce_hex")
        val ct = Crypto.seal(vk, nonce, "secret".toByteArray())
        ct[0] = (ct[0].toInt() xor 0xff).toByte()
        assertFailsWith<Exception> { Crypto.open(vk, nonce, ct) }
    }
}
