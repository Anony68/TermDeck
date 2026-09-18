package com.termdeck.vault

import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.modes.ChaCha20Poly1305
import org.bouncycastle.crypto.params.Argon2Parameters
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.ParametersWithIV

/**
 * TermDeck E2EE vault cryptography — the Kotlin twin of the Rust `vault-crypto` crate.
 *
 * Every parameter must match Rust exactly so vaults created on desktop unlock on Android and
 * vice-versa. `CryptoTest` verifies this against the shared `test-vectors.json`.
 *
 * KDF: Argon2id (v0x13, m=64MiB, t=3, p=4). AEAD: XChaCha20-Poly1305 (24-byte nonce,
 * 16-byte tag), implemented as HChaCha20 subkey derivation + IETF ChaCha20-Poly1305.
 */
object Crypto {
    const val ARGON_M_COST = 64 * 1024
    const val ARGON_T_COST = 3
    const val ARGON_P_COST = 4
    private const val KEY_LEN = 32

    fun deriveMasterKey(password: String, salt: ByteArray): ByteArray =
        argon2id(password.toByteArray(Charsets.UTF_8), salt)

    fun deriveKek(masterKey: ByteArray): ByteArray = hkdf(masterKey, "termdeck-kek")
    fun deriveAuthSecret(masterKey: ByteArray): ByteArray = hkdf(masterKey, "termdeck-auth")

    /** Argon2id → 32 bytes, matching RustCrypto's `argon2` with the fixed parameters. */
    fun argon2id(password: ByteArray, salt: ByteArray): ByteArray {
        val params = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .withMemoryAsKB(ARGON_M_COST)
            .withIterations(ARGON_T_COST)
            .withParallelism(ARGON_P_COST)
            .withSalt(salt)
            .build()
        val gen = Argon2BytesGenerator()
        gen.init(params)
        val out = ByteArray(KEY_LEN)
        gen.generateBytes(password, out)
        return out
    }

    /** HKDF-SHA256 with a null (all-zero) salt — matches `Hkdf::new(None, ikm)` in Rust. */
    private fun hkdf(ikm: ByteArray, info: String): ByteArray {
        val gen = HKDFBytesGenerator(SHA256Digest())
        gen.init(HKDFParameters(ikm, null, info.toByteArray(Charsets.UTF_8)))
        val out = ByteArray(KEY_LEN)
        gen.generateBytes(out, 0, KEY_LEN)
        return out
    }

    /** Strip formatting from a recovery code, matching the Rust normalizer. */
    fun normalizeRecoveryCode(code: String): String =
        code.filter { it.isLetterOrDigit() }.uppercase()

    fun deriveRecoveryKey(code: String, salt: ByteArray): ByteArray =
        argon2id(normalizeRecoveryCode(code).toByteArray(Charsets.UTF_8), salt)

    /** XChaCha20-Poly1305 seal: returns ciphertext||tag. */
    fun seal(key: ByteArray, nonce24: ByteArray, plaintext: ByteArray): ByteArray =
        aead(true, key, nonce24, plaintext)

    /** XChaCha20-Poly1305 open: input is ciphertext||tag; throws on tamper/wrong key. */
    fun open(key: ByteArray, nonce24: ByteArray, ciphertext: ByteArray): ByteArray =
        aead(false, key, nonce24, ciphertext)

    private fun aead(encrypt: Boolean, key: ByteArray, nonce24: ByteArray, input: ByteArray): ByteArray {
        require(nonce24.size == 24) { "XChaCha20 nonce must be 24 bytes" }
        val subkey = hchacha20(key, nonce24.copyOfRange(0, 16))
        val ietfNonce = ByteArray(12)
        System.arraycopy(nonce24, 16, ietfNonce, 4, 8) // 0x00000000 || nonce[16..24]
        val aead = ChaCha20Poly1305()
        aead.init(encrypt, ParametersWithIV(KeyParameter(subkey), ietfNonce))
        val out = ByteArray(aead.getOutputSize(input.size))
        var off = aead.processBytes(input, 0, input.size, out, 0)
        off += aead.doFinal(out, off)
        return if (off == out.size) out else out.copyOfRange(0, off)
    }

    // ---- HChaCha20 (RFC draft): 20-round ChaCha core over constants||key||nonce16,
    // emitting words 0..3 and 12..15 with no feed-forward addition. ----
    private fun hchacha20(key: ByteArray, nonce16: ByteArray): ByteArray {
        val x = IntArray(16)
        x[0] = 0x61707865; x[1] = 0x3320646e; x[2] = 0x79622d32; x[3] = 0x6b206574
        for (i in 0 until 8) x[4 + i] = leInt(key, i * 4)
        for (i in 0 until 4) x[12 + i] = leInt(nonce16, i * 4)
        repeat(10) { // 10 double-rounds = 20 rounds
            quarterRound(x, 0, 4, 8, 12)
            quarterRound(x, 1, 5, 9, 13)
            quarterRound(x, 2, 6, 10, 14)
            quarterRound(x, 3, 7, 11, 15)
            quarterRound(x, 0, 5, 10, 15)
            quarterRound(x, 1, 6, 11, 12)
            quarterRound(x, 2, 7, 8, 13)
            quarterRound(x, 3, 4, 9, 14)
        }
        val out = ByteArray(32)
        val words = intArrayOf(x[0], x[1], x[2], x[3], x[12], x[13], x[14], x[15])
        for (i in words.indices) putLeInt(out, i * 4, words[i])
        return out
    }

    private fun quarterRound(x: IntArray, a: Int, b: Int, c: Int, d: Int) {
        x[a] += x[b]; x[d] = rotl(x[d] xor x[a], 16)
        x[c] += x[d]; x[b] = rotl(x[b] xor x[c], 12)
        x[a] += x[b]; x[d] = rotl(x[d] xor x[a], 8)
        x[c] += x[d]; x[b] = rotl(x[b] xor x[c], 7)
    }
    private fun rotl(v: Int, n: Int) = (v shl n) or (v ushr (32 - n))
    private fun leInt(b: ByteArray, o: Int): Int =
        (b[o].toInt() and 0xff) or ((b[o + 1].toInt() and 0xff) shl 8) or
            ((b[o + 2].toInt() and 0xff) shl 16) or ((b[o + 3].toInt() and 0xff) shl 24)
    private fun putLeInt(b: ByteArray, o: Int, v: Int) {
        b[o] = v.toByte(); b[o + 1] = (v ushr 8).toByte()
        b[o + 2] = (v ushr 16).toByte(); b[o + 3] = (v ushr 24).toByte()
    }

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
    fun unhex(s: String): ByteArray = ByteArray(s.length / 2) { ((s[it * 2].digitToInt(16) shl 4) or s[it * 2 + 1].digitToInt(16)).toByte() }
}
