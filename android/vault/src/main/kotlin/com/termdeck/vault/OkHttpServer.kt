package com.termdeck.vault

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

/** Real [Server] over HTTPS, mirroring the desktop `cloud.rs` client and the server's
 *  snake_case contract. */
class OkHttpServer(baseUrl: String, private val client: OkHttpClient = OkHttpClient()) : Server {
    private val base = baseUrl.trimEnd('/')
    private val jsonType = "application/json".toMediaType()

    private fun post(path: String, token: String?, body: JSONObject): JSONObject {
        val b = Request.Builder().url(base + path).post(body.toString().toRequestBody(jsonType))
        if (token != null) b.header("Authorization", "Bearer $token")
        client.newCall(b.build()).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw RuntimeException("HTTP ${resp.code}: $text")
            return if (text.isEmpty()) JSONObject() else JSONObject(text)
        }
    }

    private fun get(path: String, token: String): JSONObject {
        val req = Request.Builder().url(base + path).header("Authorization", "Bearer $token").build()
        client.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw RuntimeException("HTTP ${resp.code}: $text")
            return JSONObject(text)
        }
    }

    private fun argonParams() = JSONObject().put("m", Crypto.ARGON_M_COST).put("t", Crypto.ARGON_T_COST).put("p", Crypto.ARGON_P_COST)

    private fun accountFields(o: JSONObject, a: AccountMaterial): JSONObject = o
        .put("kdf_version", a.kdfVersion)
        .put("salt_hex", a.saltHex)
        .put("argon_params", argonParams())
        .put("protected_vk_hex", a.protectedVkHex)
        .put("protected_vk_nonce_hex", a.protectedVkNonceHex)
        .put("recovery_salt_hex", a.recoverySaltHex)
        .put("recovery_protected_vk_hex", a.recoveryProtectedVkHex)
        .put("recovery_protected_vk_nonce_hex", a.recoveryProtectedVkNonceHex)

    private fun parseMaterial(o: JSONObject) = AccountMaterial(
        kdfVersion = o.optInt("kdf_version", 1),
        saltHex = o.optString("salt_hex"),
        protectedVkHex = o.optString("protected_vk_hex"),
        protectedVkNonceHex = o.optString("protected_vk_nonce_hex"),
        recoverySaltHex = o.optString("recovery_salt_hex"),
        recoveryProtectedVkHex = o.optString("recovery_protected_vk_hex"),
        recoveryProtectedVkNonceHex = o.optString("recovery_protected_vk_nonce_hex"),
    )

    override fun register(email: String, authSecretHex: String, recoveryAuthSecretHex: String, account: AccountMaterial): String {
        val body = accountFields(JSONObject(), account)
            .put("email", email).put("auth_secret_hex", authSecretHex)
            .put("recovery_auth_secret_hex", recoveryAuthSecretHex)
        return post("/v1/auth/register", null, body).getString("token")
    }

    override fun fetchMaterial(email: String): AccountMaterial =
        parseMaterial(post("/v1/auth/recover-begin", null, JSONObject().put("email", email)))

    override fun login(email: String, authSecretHex: String): LoginData {
        val o = post("/v1/auth/login", null, JSONObject().put("email", email).put("auth_secret_hex", authSecretHex))
        return LoginData(o.getString("token"), parseMaterial(o))
    }

    override fun changePassword(token: String, newAuthSecretHex: String, account: AccountMaterial) {
        post("/v1/auth/change-password", token, accountFields(JSONObject(), account).put("new_auth_secret_hex", newAuthSecretHex))
    }

    override fun recoverComplete(email: String, recoveryAuthSecretHex: String, newAuthSecretHex: String, account: AccountMaterial): String {
        val body = accountFields(JSONObject(), account)
            .put("email", email).put("recovery_auth_secret_hex", recoveryAuthSecretHex)
            .put("new_auth_secret_hex", newAuthSecretHex)
        return post("/v1/auth/recover-complete", null, body).getString("token")
    }

    override fun pull(token: String, since: Long): Pair<List<ServerRecord>, Long> {
        val o = get("/v1/sync?since=$since", token)
        val arr = o.optJSONArray("records") ?: JSONArray()
        val recs = (0 until arr.length()).map {
            val r = arr.getJSONObject(it)
            ServerRecord(r.getString("id"), r.optString("ciphertext_hex"), r.optString("nonce_hex"), r.optLong("seq"), r.optBoolean("deleted"))
        }
        return recs to o.optLong("cursor")
    }

    override fun push(token: String, changes: List<ServerChange>): Long {
        val arr = JSONArray()
        for (c in changes) arr.put(JSONObject().put("id", c.id).put("ciphertext_hex", c.ciphertextHex).put("nonce_hex", c.nonceHex).put("deleted", c.deleted))
        return post("/v1/sync", token, JSONObject().put("changes", arr)).optLong("cursor")
    }
}
