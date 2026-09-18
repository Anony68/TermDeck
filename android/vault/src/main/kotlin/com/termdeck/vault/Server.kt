package com.termdeck.vault

/**
 * Transport to the TermDeck sync server. The wire contract is snake_case JSON (see
 * [OkHttpServer]); this interface is what [VaultManager] depends on, so tests can swap in
 * an in-memory fake.
 */
interface Server {
    fun register(
        email: String,
        authSecretHex: String,
        recoveryAuthSecretHex: String,
        account: AccountMaterial,
    ): String // token

    /** Public salt + wrapped material for an email (pre-auth; server's recover-begin). */
    fun fetchMaterial(email: String): AccountMaterial

    fun login(email: String, authSecretHex: String): LoginData

    fun changePassword(token: String, newAuthSecretHex: String, account: AccountMaterial)

    fun recoverComplete(
        email: String,
        recoveryAuthSecretHex: String,
        newAuthSecretHex: String,
        account: AccountMaterial,
    ): String // token

    fun pull(token: String, since: Long): Pair<List<ServerRecord>, Long>

    fun push(token: String, changes: List<ServerChange>): Long
}
