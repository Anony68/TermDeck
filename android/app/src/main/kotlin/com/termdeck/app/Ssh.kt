package com.termdeck.app

import android.content.SharedPreferences
import com.termdeck.vault.Host
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.SecurityUtils
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.sftp.SFTPClient
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.password.PasswordUtils
import java.io.File
import java.security.PublicKey
import kotlin.concurrent.thread

data class SftpEntry(val name: String, val path: String, val isDir: Boolean, val size: Long)

/**
 * Trust-on-first-use host-key verifier: pins each host's key fingerprint in SharedPreferences
 * on first connect and rejects any later mismatch (MITM guard), matching the desktop's TOFU.
 */
class TofuVerifier(private val prefs: SharedPreferences) : HostKeyVerifier {
    override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
        val fp = SecurityUtils.getFingerprint(key)
        val id = "hostkey:$hostname:$port"
        val known = prefs.getString(id, null)
        return when (known) {
            null -> { prefs.edit().putString(id, fp).apply(); true } // first use → pin
            fp -> true
            else -> false // changed → refuse (possible MITM)
        }
    }
    override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
}

/**
 * One SSH connection to a host, providing an interactive shell and an SFTP client.
 * Blocking calls — invoke from a background dispatcher.
 */
class SshSession(
    private val host: Host,
    private val secret: String,
    private val keyContent: String,
    private val knownHosts: SharedPreferences,
) {
    private var ssh: SSHClient? = null
    private var shell: Session.Shell? = null
    private var session: Session? = null
    private var sftpClient: SFTPClient? = null

    @Volatile var shellAlive = false
        private set

    fun connect() {
        val c = SSHClient()
        c.addHostKeyVerifier(TofuVerifier(knownHosts))
        c.connect(host.host, host.port)
        if (host.auth == "key" && keyContent.isNotBlank()) {
            val kp = if (secret.isNotBlank())
                c.loadKeys(keyContent, null, PasswordUtils.createOneOff(secret.toCharArray()))
            else c.loadKeys(keyContent, null, null)
            c.authPublickey(host.user, kp)
        } else {
            c.authPassword(host.user, secret)
        }
        ssh = c
    }

    /** Start an interactive shell; `onOutput` is called (off the main thread) with each chunk. */
    fun openShell(onOutput: (String) -> Unit) {
        val c = ssh ?: error("not connected")
        val s = c.startSession()
        s.allocatePTY("xterm", 80, 24, 0, 0, emptyMap())
        val sh = s.startShell()
        session = s; shell = sh; shellAlive = true
        // Land in the configured remote dir + optional preset command.
        buildString {
            host.remotePath?.takeIf { it.isNotBlank() }?.let { append("cd \"$it\"\n") }
            host.presetCommand?.takeIf { it.isNotBlank() }?.let { append("$it\n") }
        }.takeIf { it.isNotEmpty() }?.let { send(it) }
        thread(name = "ssh-shell-${host.id}") {
            val buf = ByteArray(8192)
            val ins = sh.inputStream
            try {
                while (true) {
                    val n = ins.read(buf)
                    if (n < 0) break
                    onOutput(String(buf, 0, n, Charsets.UTF_8))
                }
            } catch (_: Exception) {
            } finally {
                shellAlive = false
            }
        }
    }

    fun send(data: String) {
        shell?.outputStream?.apply { write(data.toByteArray(Charsets.UTF_8)); flush() }
    }

    private fun sftp(): SFTPClient {
        sftpClient?.let { return it }
        val c = ssh ?: error("not connected")
        return c.newSFTPClient().also { sftpClient = it }
    }

    fun list(path: String): List<SftpEntry> =
        sftp().ls(path).map { SftpEntry(it.name, it.path, it.isDirectory, it.attributes.size) }
            .sortedWith(compareByDescending<SftpEntry> { it.isDir }.thenBy { it.name.lowercase() })

    fun homeDir(): String = try { sftp().canonicalize(".") } catch (_: Exception) { host.remotePath?.ifBlank { "/" } ?: "/" }

    /** Download a remote file into `dir`; returns the local file. */
    fun download(remotePath: String, name: String, dir: File): File {
        val local = File(dir, name)
        sftp().get(remotePath, local.absolutePath)
        return local
    }

    fun close() {
        runCatching { shell?.close() }
        runCatching { session?.close() }
        runCatching { sftpClient?.close() }
        runCatching { ssh?.disconnect() }
        shellAlive = false
    }
}
