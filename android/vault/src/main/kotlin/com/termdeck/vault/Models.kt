package com.termdeck.vault

/** SSH connection settings for a VPS (secret + key content are held separately). */
data class Host(
    val id: String,
    val name: String,
    val host: String,
    val port: Int,
    val user: String,
    val auth: String,            // "password" | "key"
    val keyPath: String? = null, // desktop-only path; ignored on Android
    val remotePath: String? = null,
    val presetCommand: String? = null,
)

/** A decrypted vault entry held in memory while unlocked: the host + its credentials. */
data class VaultEntry(
    val host: Host,
    val secret: String = "",      // password or key passphrase
    val keyContent: String = "",  // private key PEM (for key auth)
)

/** Non-secret account material (public salt + E2EE-wrapped keys), cached to unlock offline. */
data class AccountMaterial(
    val kdfVersion: Int,
    val saltHex: String,
    val protectedVkHex: String,
    val protectedVkNonceHex: String,
    val recoverySaltHex: String,
    val recoveryProtectedVkHex: String,
    val recoveryProtectedVkNonceHex: String,
)

/** One encrypted record as the server stores it. */
data class ServerRecord(
    val id: String,
    val ciphertextHex: String,
    val nonceHex: String,
    val seq: Long,
    val deleted: Boolean,
)

/** A record change to upload (server assigns the seq). */
data class ServerChange(
    val id: String,
    val ciphertextHex: String,
    val nonceHex: String,
    val deleted: Boolean,
)

/** What the server returns on a successful login. */
data class LoginData(val token: String, val account: AccountMaterial)
