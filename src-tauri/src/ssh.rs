//! SSH terminals + SFTP sessions (via libssh2). An SSH terminal speaks the same
//! `PtyEvent` channel protocol as local PTYs, so the frontend xterm doesn't care
//! where the bytes come from. Host keys are pinned on first use (TOFU) in
//! `known_hosts.json` under the app config dir; passwords/passphrases live in the
//! OS credential store (keyring), never in the persisted JSON state.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use ssh2::{HashType, Session};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};

use crate::pty::PtyEvent;

const KEYRING_SERVICE: &str = "TermDeck";

/// SSH connection settings as persisted on a pane (secret NOT included).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// "password" | "key"
    pub auth: String,
    pub key_path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    /// Unix seconds (0 when unknown).
    pub modified: u64,
    /// e.g. "drwxr-xr-x" for remote, "" for local.
    pub perms: String,
    /// Unix permission bits (rwx) for remote entries; 0 for local.
    pub mode: u32,
    pub is_symlink: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferProgress {
    pane_id: String,
    name: String,
    done: u64,
    total: u64,
}

/// Live SSH connection state, pushed to the frontend on `ssh://status`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshStatus {
    pane_id: String,
    /// "connected" | "reconnecting" | "disconnected".
    state: String,
    attempt: u32,
}

enum SshOp {
    Write(Vec<u8>),
    Resize(u16, u16),
    Kill,
}

/// Why the shell I/O loop returned.
enum IoExit {
    /// User asked to close the pane (or the op channel dropped).
    Kill,
    /// Remote shell exited cleanly (e.g. `exit`) — do NOT reconnect.
    Clean(i32),
    /// Connection error / keepalive failure — try to reconnect.
    Died,
}

const SSH_MAX_RECONNECT: u32 = 5;

struct SftpConn {
    /// Keeps the underlying connection alive alongside the SFTP handle.
    _sess: Session,
    sftp: ssh2::Sftp,
}

pub struct SshManager {
    terms: Arc<Mutex<HashMap<String, Sender<SshOp>>>>,
    sftps: Arc<Mutex<HashMap<String, Arc<Mutex<SftpConn>>>>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            terms: Arc::new(Mutex::new(HashMap::new())),
            sftps: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Default for SshManager {
    fn default() -> Self {
        Self::new()
    }
}

// ---------- secrets (OS credential store) ----------

fn keyring_entry(pane_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("ssh:{pane_id}")).map_err(|e| e.to_string())
}

pub fn get_secret(pane_id: &str) -> Option<String> {
    keyring_entry(pane_id).ok()?.get_password().ok()
}

#[tauri::command(rename_all = "camelCase")]
pub fn secret_set(pane_id: String, value: String) -> Result<(), String> {
    let entry = keyring_entry(&pane_id)?;
    if value.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(&value).map_err(|e| e.to_string())
}

/// Copy a pane's saved password/passphrase to another pane, so an SFTP browser
/// opened from an SSH terminal can authenticate without re-asking the user.
#[tauri::command(rename_all = "camelCase")]
pub fn secret_copy(from_pane_id: String, to_pane_id: String) -> Result<(), String> {
    if let Some(v) = get_secret(&from_pane_id) {
        keyring_entry(&to_pane_id)?
            .set_password(&v)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn secret_delete(pane_id: String) -> Result<(), String> {
    if let Ok(entry) = keyring_entry(&pane_id) {
        let _ = entry.delete_credential();
    }
    Ok(())
}

// ---------- host key pinning (TOFU) ----------

fn known_hosts_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    dir.join("known_hosts.json")
}

fn check_host_key(app: &AppHandle, sess: &Session, host: &str, port: u16) -> Result<(), String> {
    let hash = sess
        .host_key_hash(HashType::Sha256)
        .ok_or("không đọc được host key")?;
    let fp = format!("SHA256:{}", base64::engine::general_purpose::STANDARD.encode(hash));
    let path = known_hosts_path(app);
    let mut map: HashMap<String, String> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let key = format!("{host}:{port}");
    match map.get(&key) {
        Some(saved) if saved == &fp => Ok(()),
        Some(saved) => Err(format!(
            "HOST KEY THAY ĐỔI cho {key}!\nĐã lưu: {saved}\nHiện tại: {fp}\nCó thể là tấn công MITM. Nếu chắc chắn server đã đổi key, xóa mục này trong {}",
            path.display()
        )),
        None => {
            map.insert(key, fp);
            std::fs::write(&path, serde_json::to_string_pretty(&map).unwrap_or_default())
                .map_err(|e| e.to_string())?;
            Ok(())
        }
    }
}

// ---------- connection ----------

/// Expand a leading `~` / `~/` to the user's home directory. Other paths pass
/// through unchanged. (libssh2 does not do tilde expansion itself.)
fn expand_tilde(p: &str) -> String {
    if p == "~" || p.starts_with("~/") || p.starts_with("~\\") {
        if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
            return format!("{home}{}", &p[1..]);
        }
    }
    p.to_string()
}

fn connect(app: &AppHandle, pane_id: &str, cfg: &SshConfig) -> Result<Session, String> {
    let addr = format!("{}:{}", cfg.host, cfg.port);
    let sock = addr
        .to_socket_addrs()
        .map_err(|e| format!("không phân giải được {addr}: {e}"))?
        .next()
        .ok_or_else(|| format!("không phân giải được {addr}"))?;
    let tcp = TcpStream::connect_timeout(&sock, Duration::from_secs(12))
        .map_err(|e| format!("không kết nối được {addr}: {e}"))?;
    tcp.set_nodelay(true).ok();

    let mut sess = Session::new().map_err(|e| e.to_string())?;
    // Bound the handshake + auth so a silent/wrong-protocol server can't hang the
    // connection forever. Cleared to 0 (no timeout) once authenticated so it
    // never interrupts long-running shell I/O or SFTP transfers.
    sess.set_timeout(15_000);
    sess.set_tcp_stream(tcp);
    sess.handshake().map_err(|e| format!("SSH handshake lỗi: {e}"))?;

    check_host_key(app, &sess, &cfg.host, cfg.port)?;

    // Primary auth method, then fall back to ssh-agent (B2) so users with keys
    // loaded in ssh-agent / Pageant connect without configuring a key file.
    let secret = get_secret(pane_id);
    let mut auth_err: Option<String> = None;
    if cfg.auth == "key" {
        let key = cfg.key_path.clone().unwrap_or_default();
        if key.is_empty() {
            auth_err = Some("chưa chọn file private key".into());
        } else {
            // libssh2 takes the path literally — expand a leading `~` ourselves,
            // and check the file exists so a wrong path gives a clear reason
            // instead of an opaque auth failure.
            let key = expand_tilde(&key);
            if !Path::new(&key).is_file() {
                auth_err = Some(format!("không tìm thấy file private key: {key}"));
            } else if let Err(e) =
                sess.userauth_pubkey_file(&cfg.user, None, Path::new(&key), secret.as_deref())
            {
                auth_err = Some(format!("xác thực bằng key thất bại: {e}"));
            }
        }
    } else {
        match &secret {
            Some(p) => {
                if let Err(e) = sess.userauth_password(&cfg.user, p) {
                    auth_err = Some(format!("sai mật khẩu hoặc server từ chối: {e}"));
                }
            }
            None => auth_err = Some("chưa lưu mật khẩu cho terminal này".into()),
        }
    }
    if !sess.authenticated() {
        // Best-effort ssh-agent fallback (ignored if no agent / no matching key).
        let _ = sess.userauth_agent(&cfg.user);
    }
    if !sess.authenticated() {
        return Err(auth_err.unwrap_or_else(|| "xác thực thất bại".into()));
    }
    sess.set_timeout(0); // no timeout for post-auth I/O (shell / SFTP transfers)
    sess.set_keepalive(true, 30);
    Ok(sess)
}

// ---------- SSH terminal ----------

#[tauri::command(rename_all = "camelCase")]
pub fn spawn_ssh(
    app: AppHandle,
    state: tauri::State<SshManager>,
    pane_id: String,
    cfg: SshConfig,
    cols: u16,
    rows: u16,
    command: Option<String>,
    on_event: Channel<PtyEvent>,
) -> Result<(), String> {
    // Replace any existing session (restart).
    if let Some(tx) = state.terms.lock().unwrap().remove(&pane_id) {
        let _ = tx.send(SshOp::Kill);
    }

    // Register the op channel up front so write/resize/kill during connect queue.
    let (tx, rx) = mpsc::channel::<SshOp>();
    state.terms.lock().unwrap().insert(pane_id.clone(), tx);
    let terms = state.terms.clone();

    // Everything below blocks (TCP connect, handshake, auth). Run it ALL on a
    // background thread so the command returns immediately and the UI never
    // freezes when a host is unreachable or the server never answers. The thread
    // also auto-reconnects on connection loss (up to SSH_MAX_RECONNECT).
    std::thread::spawn(move || {
        let status = |state: &str, attempt: u32| {
            let _ = app.emit(
                "ssh://status",
                SshStatus { pane_id: pane_id.clone(), state: state.into(), attempt },
            );
        };
        let fail = |on_event: &Channel<PtyEvent>, msg: String| {
            let line = format!("\r\n\x1b[31m{msg}\x1b[0m\r\n");
            let _ = on_event.send(PtyEvent::Data { data: line.into_bytes() });
            // Carry the reason on the Exit too: the terminal is swapped for the
            // "exited" overlay, so a Data-only message would never be seen.
            let _ = on_event.send(PtyEvent::Exit { code: -1, error: Some(msg) });
        };
        let note = |on_event: &Channel<PtyEvent>, msg: String| {
            let line = format!("\r\n\x1b[33m{msg}\x1b[0m\r\n");
            let _ = on_event.send(PtyEvent::Data { data: line.into_bytes() });
        };

        let mut attempt: u32 = 0;
        let mut first = true;
        loop {
            // ---- (re)connect ----
            let sess = match connect(&app, &pane_id, &cfg) {
                Ok(s) => s,
                Err(e) => {
                    if first {
                        fail(&on_event, e);
                        break;
                    }
                    attempt += 1;
                    if attempt > SSH_MAX_RECONNECT {
                        let msg = "Không kết nối lại được — đã dừng.".to_string();
                        note(&on_event, msg.clone());
                        status("disconnected", attempt);
                        let _ = on_event.send(PtyEvent::Exit { code: -1, error: Some(msg) });
                        break;
                    }
                    status("reconnecting", attempt);
                    std::thread::sleep(Duration::from_secs((attempt as u64).min(5)));
                    continue;
                }
            };
            let mut ch = match sess.channel_session().and_then(|mut ch| {
                ch.request_pty("xterm-256color", None, Some((cols as u32, rows as u32, 0, 0)))?;
                ch.shell()?;
                Ok(ch)
            }) {
                Ok(ch) => ch,
                Err(e) => {
                    if first {
                        fail(&on_event, format!("mở shell từ xa lỗi: {e}"));
                        break;
                    }
                    attempt += 1;
                    status("reconnecting", attempt);
                    std::thread::sleep(Duration::from_secs((attempt as u64).min(5)));
                    continue;
                }
            };

            if !first {
                note(&on_event, "Đã kết nối lại.".into());
            }
            // (Re)apply the startup command so a reconnect lands back in context.
            if let Some(c) = &command {
                if !c.trim().is_empty() {
                    let _ = ch.write_all(format!("{c}\n").as_bytes());
                    let _ = ch.flush();
                }
            }
            first = false;
            attempt = 0;
            status("connected", 0);
            sess.set_blocking(false);

            // ---- I/O loop with a keepalive health pump ----
            let outcome = run_ssh_io(&sess, &mut ch, &rx, &on_event);
            sess.set_blocking(true);
            let _ = ch.close();
            let _ = ch.wait_close();

            match outcome {
                IoExit::Kill => break,
                IoExit::Clean(code) => {
                    let _ = on_event.send(PtyEvent::Exit { code, error: None });
                    break;
                }
                IoExit::Died => {
                    attempt += 1;
                    if attempt > SSH_MAX_RECONNECT {
                        let msg = "Mất kết nối — đã thử lại nhiều lần, dừng.".to_string();
                        note(&on_event, msg.clone());
                        status("disconnected", attempt);
                        let _ = on_event.send(PtyEvent::Exit { code: -1, error: Some(msg) });
                        break;
                    }
                    note(&on_event, format!("Mất kết nối — đang thử lại ({attempt})…"));
                    status("reconnecting", attempt);
                    std::thread::sleep(Duration::from_secs((attempt as u64).min(5)));
                    continue;
                }
            }
        }
        terms.lock().unwrap().remove(&pane_id);
    });

    Ok(())
}

/// Non-blocking read/write pump for one SSH shell channel. Also pings keepalive
/// every ~15 s so a dead connection is detected promptly. Returns why it ended.
fn run_ssh_io(
    sess: &Session,
    ch: &mut ssh2::Channel,
    rx: &std::sync::mpsc::Receiver<SshOp>,
    on_event: &Channel<PtyEvent>,
) -> IoExit {
    let mut buf = [0u8; 8192];
    let mut pending: Vec<u8> = Vec::new();
    let mut last_keepalive = std::time::Instant::now();
    loop {
        // 1) queued ops from the frontend
        loop {
            match rx.try_recv() {
                Ok(SshOp::Write(d)) => pending.extend_from_slice(&d),
                Ok(SshOp::Resize(c, r)) => {
                    let _ = ch.request_pty_size(c as u32, r as u32, None, None);
                }
                Ok(SshOp::Kill) => return IoExit::Kill,
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return IoExit::Kill,
            }
        }
        // 2) flush pending writes (non-blocking, keep the remainder)
        let mut wrote = false;
        while !pending.is_empty() {
            match ch.write(&pending) {
                Ok(0) => break,
                Ok(n) => {
                    pending.drain(..n);
                    wrote = true;
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => return IoExit::Died,
            }
        }
        // 3) read output
        let mut read_any = false;
        match ch.read(&mut buf) {
            Ok(0) => {
                if ch.eof() {
                    return IoExit::Clean(ch.exit_status().unwrap_or(0));
                }
            }
            Ok(n) => {
                read_any = true;
                if on_event.send(PtyEvent::Data { data: buf[..n].to_vec() }).is_err() {
                    return IoExit::Kill;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => return IoExit::Died,
        }
        // 4) keepalive health check
        if last_keepalive.elapsed() >= Duration::from_secs(15) {
            last_keepalive = std::time::Instant::now();
            if sess.keepalive_send().is_err() {
                return IoExit::Died;
            }
        }
        if !read_any && !wrote {
            std::thread::sleep(Duration::from_millis(8));
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn write_ssh(state: tauri::State<SshManager>, pane_id: String, data: String) -> Result<(), String> {
    if let Some(tx) = state.terms.lock().unwrap().get(&pane_id) {
        tx.send(SshOp::Write(data.into_bytes())).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn resize_ssh(
    state: tauri::State<SshManager>,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if let Some(tx) = state.terms.lock().unwrap().get(&pane_id) {
        let _ = tx.send(SshOp::Resize(cols, rows));
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn kill_ssh(state: tauri::State<SshManager>, pane_id: String) -> Result<(), String> {
    if let Some(tx) = state.terms.lock().unwrap().remove(&pane_id) {
        let _ = tx.send(SshOp::Kill);
    }
    Ok(())
}

// ---------- SFTP ----------

fn get_sftp(state: &tauri::State<SshManager>, pane_id: &str) -> Result<Arc<Mutex<SftpConn>>, String> {
    state
        .sftps
        .lock()
        .unwrap()
        .get(pane_id)
        .cloned()
        .ok_or_else(|| "chưa kết nối SFTP".to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn sftp_connect(
    app: AppHandle,
    state: tauri::State<'_, SshManager>,
    pane_id: String,
    cfg: SshConfig,
) -> Result<(), String> {
    if state.sftps.lock().unwrap().contains_key(&pane_id) {
        return Ok(());
    }
    // Connect (blocking TCP + handshake) off the command thread so an unreachable
    // host can't freeze the UI; the frontend awaits the returned Result as before.
    let sftps = state.sftps.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sess = connect(&app, &pane_id, &cfg)?;
        let sftp = sess.sftp().map_err(|e| format!("mở SFTP lỗi: {e}"))?;
        sftps
            .lock()
            .unwrap()
            .insert(pane_id, Arc::new(Mutex::new(SftpConn { _sess: sess, sftp })));
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub fn sftp_disconnect(state: tauri::State<SshManager>, pane_id: String) -> Result<(), String> {
    state.sftps.lock().unwrap().remove(&pane_id);
    Ok(())
}

/// Resolve the remote directory the Browser pane should open at: the preferred
/// path (config / last-used) when it exists and is a directory, otherwise the
/// login home (`~`) — mirroring how the terminal falls back to home for a
/// missing cwd. `prefer` may be empty, `~`, or start with `~/`.
#[tauri::command(rename_all = "camelCase")]
pub fn sftp_home(
    state: tauri::State<SshManager>,
    pane_id: String,
    prefer: String,
) -> Result<String, String> {
    let conn = get_sftp(&state, &pane_id)?;
    let conn = conn.lock().unwrap();

    // Remote home: realpath(".") is the login/current dir. Fall back to "/".
    let home = conn
        .sftp
        .realpath(Path::new("."))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".to_string());

    let prefer = prefer.trim();
    let target = if prefer.is_empty() || prefer == "~" {
        home.clone()
    } else if let Some(rest) = prefer.strip_prefix("~/") {
        format!("{}/{}", home.trim_end_matches('/'), rest)
    } else {
        prefer.to_string()
    };

    // Use the preferred path only if it exists and is a directory; else home.
    let usable = conn
        .sftp
        .stat(Path::new(&target))
        .map(|st| st.is_dir())
        .unwrap_or(false);
    let chosen = if usable { target } else { home };
    Ok(conn
        .sftp
        .realpath(Path::new(&chosen))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(chosen))
}

fn perms_string(mode: u32, is_dir: bool, is_symlink: bool) -> String {
    let mut s = String::with_capacity(10);
    s.push(if is_symlink {
        'l'
    } else if is_dir {
        'd'
    } else {
        '-'
    });
    for shift in [6u32, 3, 0] {
        let bits = (mode >> shift) & 7;
        s.push(if bits & 4 != 0 { 'r' } else { '-' });
        s.push(if bits & 2 != 0 { 'w' } else { '-' });
        s.push(if bits & 1 != 0 { 'x' } else { '-' });
    }
    s
}

#[tauri::command(rename_all = "camelCase")]
pub fn sftp_list(
    state: tauri::State<SshManager>,
    pane_id: String,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let conn = get_sftp(&state, &pane_id)?;
    let conn = conn.lock().unwrap();
    let list = conn
        .sftp
        .readdir(Path::new(&path))
        .map_err(|e| format!("đọc thư mục lỗi: {e}"))?;
    Ok(list
        .into_iter()
        .filter_map(|(p, st)| {
            let name = p.file_name()?.to_string_lossy().to_string();
            let is_dir = st.is_dir();
            let full = st.perm.unwrap_or(0);
            let is_symlink = full & 0o170000 == 0o120000; // S_IFLNK
            Some(FileEntry {
                name,
                size: st.size.unwrap_or(0),
                is_dir,
                modified: st.mtime.unwrap_or(0),
                perms: perms_string(full, is_dir, is_symlink),
                mode: full & 0o777,
                is_symlink,
            })
        })
        .collect())
}

/// One recursive-search result (C5).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
}

/// Recursively search a remote subtree for names containing `query` (bounded).
#[tauri::command(rename_all = "camelCase")]
pub async fn sftp_search(
    state: tauri::State<'_, SshManager>,
    pane_id: String,
    root: String,
    query: String,
) -> Result<Vec<SearchHit>, String> {
    let conn = get_sftp(&state, &pane_id)?;
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let conn = conn.lock().unwrap();
        let mut hits: Vec<SearchHit> = Vec::new();
        let mut stack = vec![root];
        let mut visited = 0u32;
        while let Some(dir) = stack.pop() {
            if hits.len() >= 500 || visited >= 8000 {
                break; // bound runaway trees
            }
            visited += 1;
            let list = match conn.sftp.readdir(Path::new(&dir)) {
                Ok(l) => l,
                Err(_) => continue,
            };
            for (p, st) in list {
                let name = match p.file_name() {
                    Some(n) => n.to_string_lossy().to_string(),
                    None => continue,
                };
                let full = format!("{}/{}", dir.trim_end_matches('/'), name);
                let is_dir = st.is_dir();
                if name.to_lowercase().contains(&q) {
                    hits.push(SearchHit { path: full.clone(), name, is_dir });
                }
                let is_symlink = st.perm.unwrap_or(0) & 0o170000 == 0o120000;
                if is_dir && !is_symlink {
                    stack.push(full);
                }
            }
        }
        Ok(hits)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Change permission bits of a remote file/dir (C4).
#[tauri::command(rename_all = "camelCase")]
pub fn sftp_chmod(
    state: tauri::State<SshManager>,
    pane_id: String,
    path: String,
    mode: u32,
) -> Result<(), String> {
    let conn = get_sftp(&state, &pane_id)?;
    let conn = conn.lock().unwrap();
    let stat = ssh2::FileStat {
        size: None,
        uid: None,
        gid: None,
        perm: Some(mode & 0o777),
        atime: None,
        mtime: None,
    };
    conn.sftp
        .setstat(Path::new(&path), stat)
        .map_err(|e| format!("đổi quyền lỗi: {e}"))
}

#[tauri::command(rename_all = "camelCase")]
pub fn sftp_mkdir(state: tauri::State<SshManager>, pane_id: String, path: String) -> Result<(), String> {
    let conn = get_sftp(&state, &pane_id)?;
    let conn = conn.lock().unwrap();
    conn.sftp.mkdir(Path::new(&path), 0o755).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub fn sftp_rename(
    state: tauri::State<SshManager>,
    pane_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let conn = get_sftp(&state, &pane_id)?;
    let conn = conn.lock().unwrap();
    conn.sftp
        .rename(Path::new(&from), Path::new(&to), None)
        .map_err(|e| e.to_string())
}

fn sftp_remove_rec(sftp: &ssh2::Sftp, path: &Path, is_dir: bool) -> Result<(), String> {
    if !is_dir {
        return sftp.unlink(path).map_err(|e| e.to_string());
    }
    for (p, st) in sftp.readdir(path).map_err(|e| e.to_string())? {
        sftp_remove_rec(sftp, &p, st.is_dir())?;
    }
    sftp.rmdir(path).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub fn sftp_remove(
    state: tauri::State<SshManager>,
    pane_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let conn = get_sftp(&state, &pane_id)?;
    let conn = conn.lock().unwrap();
    sftp_remove_rec(&conn.sftp, Path::new(&path), is_dir)
}

const PROGRESS_STEP: u64 = 512 * 1024;

#[tauri::command(rename_all = "camelCase")]
pub fn sftp_upload(
    app: AppHandle,
    state: tauri::State<SshManager>,
    pane_id: String,
    local: String,
    remote: String,
) -> Result<(), String> {
    let conn = get_sftp(&state, &pane_id)?;
    let conn = conn.lock().unwrap();
    let mut src = std::fs::File::open(&local).map_err(|e| format!("mở file local lỗi: {e}"))?;
    let total = src.metadata().map(|m| m.len()).unwrap_or(0);
    let mut dst = conn
        .sftp
        .create(Path::new(&remote))
        .map_err(|e| format!("tạo file remote lỗi: {e}"))?;
    let name = Path::new(&local)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| local.clone());
    let mut buf = vec![0u8; 64 * 1024];
    let mut done = 0u64;
    let mut last_emit = 0u64;
    loop {
        let n = src.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if done - last_emit >= PROGRESS_STEP {
            last_emit = done;
            let _ = app.emit(
                "sftp://progress",
                TransferProgress { pane_id: pane_id.clone(), name: name.clone(), done, total },
            );
        }
    }
    let _ = app.emit(
        "sftp://progress",
        TransferProgress { pane_id: pane_id.clone(), name, done: total.max(done), total },
    );
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn sftp_download(
    app: AppHandle,
    state: tauri::State<SshManager>,
    pane_id: String,
    remote: String,
    local: String,
) -> Result<(), String> {
    let conn = get_sftp(&state, &pane_id)?;
    let conn = conn.lock().unwrap();
    let (mut src, st) = conn
        .sftp
        .open(Path::new(&remote))
        .and_then(|mut f| {
            let st = f.stat().unwrap_or_else(|_| ssh2::FileStat {
                size: None,
                uid: None,
                gid: None,
                perm: None,
                atime: None,
                mtime: None,
            });
            Ok((f, st))
        })
        .map_err(|e| format!("mở file remote lỗi: {e}"))?;
    let total = st.size.unwrap_or(0);
    let mut dst = std::fs::File::create(&local).map_err(|e| format!("tạo file local lỗi: {e}"))?;
    let name = Path::new(&remote)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| remote.clone());
    let mut buf = vec![0u8; 64 * 1024];
    let mut done = 0u64;
    let mut last_emit = 0u64;
    loop {
        let n = src.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if done - last_emit >= PROGRESS_STEP {
            last_emit = done;
            let _ = app.emit(
                "sftp://progress",
                TransferProgress { pane_id: pane_id.clone(), name: name.clone(), done, total },
            );
        }
    }
    let _ = app.emit(
        "sftp://progress",
        TransferProgress { pane_id: pane_id.clone(), name, done: total.max(done), total },
    );
    Ok(())
}

// ---------- local filesystem (for the Browser pane) ----------

#[tauri::command]
pub fn fs_list(path: String) -> Result<Vec<FileEntry>, String> {
    // Empty path on Windows = list drives.
    #[cfg(windows)]
    if path.trim().is_empty() {
        let mut out = Vec::new();
        for c in b'A'..=b'Z' {
            let root = format!("{}:\\", c as char);
            if std::fs::metadata(&root).is_ok() {
                out.push(FileEntry {
                    name: root.clone(),
                    size: 0,
                    is_dir: true,
                    modified: 0,
                    perms: String::new(),
                    mode: 0,
                    is_symlink: false,
                });
            }
        }
        return Ok(out);
    }

    let rd = std::fs::read_dir(&path).map_err(|e| format!("đọc thư mục lỗi: {e}"))?;
    let mut out = Vec::new();
    for ent in rd.flatten() {
        let meta = match ent.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(FileEntry {
            name: ent.file_name().to_string_lossy().to_string(),
            size: meta.len(),
            is_dir: meta.is_dir(),
            modified,
            perms: String::new(),
            mode: 0,
            is_symlink: meta.file_type().is_symlink(),
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn fs_mkdir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_rename(from: String, to: String) -> Result<(), String> {
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub fn fs_remove(path: String, is_dir: bool) -> Result<(), String> {
    if is_dir {
        std::fs::remove_dir_all(&path).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(&path).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn fs_home() -> String {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default()
}

// ---------- ~/.ssh/config import (B3) ----------

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    pub alias: String,
    pub host_name: String,
    pub user: String,
    pub port: u16,
    pub identity_file: String,
}

/// Parse `~/.ssh/config` into a flat list of concrete hosts (wildcards skipped)
/// to pre-fill the New-SSH dialog.
#[tauri::command]
pub fn ssh_config_hosts() -> Vec<SshConfigHost> {
    let mut out = Vec::new();
    let home = match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        Ok(h) => h,
        Err(_) => return out,
    };
    let path = std::path::Path::new(&home).join(".ssh").join("config");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return out;
    };

    // Current block: the aliases it names + the settings gathered so far.
    let mut aliases: Vec<String> = Vec::new();
    let mut host_name = String::new();
    let mut user = String::new();
    let mut port: u16 = 22;
    let mut identity = String::new();

    let flush = |out: &mut Vec<SshConfigHost>,
                 aliases: &[String],
                 host_name: &str,
                 user: &str,
                 port: u16,
                 identity: &str| {
        for a in aliases {
            out.push(SshConfigHost {
                alias: a.clone(),
                host_name: if host_name.is_empty() { a.clone() } else { host_name.to_string() },
                user: user.to_string(),
                port,
                identity_file: identity.to_string(),
            });
        }
    };

    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.splitn(2, |c: char| c.is_whitespace() || c == '=');
        let key = parts.next().unwrap_or("").to_lowercase();
        let val = parts.next().unwrap_or("").trim().trim_matches('"').to_string();
        match key.as_str() {
            "host" => {
                // Flush the previous block, start a new one.
                flush(&mut out, &aliases, &host_name, &user, port, &identity);
                aliases = val
                    .split_whitespace()
                    .filter(|a| !a.contains('*') && !a.contains('?'))
                    .map(|a| a.to_string())
                    .collect();
                host_name.clear();
                user.clear();
                port = 22;
                identity.clear();
            }
            "hostname" => host_name = val,
            "user" => user = val,
            "port" => port = val.parse().unwrap_or(22),
            "identityfile" => {
                identity = if let Some(rest) = val.strip_prefix("~/") {
                    std::path::Path::new(&home).join(rest).to_string_lossy().to_string()
                } else {
                    val
                };
            }
            _ => {}
        }
    }
    flush(&mut out, &aliases, &host_name, &user, port, &identity);
    out
}

// ---------- Bitvise .tlp profile import ----------

/// Connection fields recovered from a Bitvise Tunnelier `.tlp` profile. The
/// password is stored machine-encrypted by Bitvise and cannot be recovered, so
/// the user still fills that in after import.
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TlpProfile {
    pub found: bool,
    pub host: String,
    pub port: u16,
    pub user: String,
}

/// Chars allowed in a hostname / IPv4 literal.
fn is_host_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_'
}

fn read_u32_be(buf: &[u8], at: usize) -> Option<u32> {
    let s = buf.get(at..at + 4)?;
    Some(u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

/// Read a 4-byte-BE-length-prefixed string at `at`, returning (string, end).
/// `ok` gates the byte charset; the whole run must satisfy it.
fn read_prefixed_str(buf: &[u8], at: usize, max: u32, ok: fn(u8) -> bool) -> Option<(String, usize)> {
    let len = read_u32_be(buf, at)?;
    if len == 0 || len > max {
        return None;
    }
    let start = at + 4;
    let end = start + len as usize;
    let slice = buf.get(start..end)?;
    if !slice.iter().all(|&b| ok(b)) {
        return None;
    }
    Some((String::from_utf8_lossy(slice).into_owned(), end))
}

/// The `.tlp` binary is an internal Bitvise format (undocumented). Rather than
/// track its evolving layout, we scan for the first `<u32 len><host><u32 port>`
/// run where host looks like a hostname/IP and port is valid, then take the
/// next short printable string as the username. Best-effort → `found: false`.
fn parse_tlp_bytes(buf: &[u8]) -> TlpProfile {
    let none = TlpProfile::default();
    // Skip the leading version string ("Tunnelier X.YZ") if present.
    let mut scan = match read_prefixed_str(buf, 0, 64, |b| b.is_ascii_graphic() || b == b' ') {
        Some((_, end)) => end,
        None => 0,
    };
    while scan + 4 < buf.len() {
        let Some((host, after_host)) = read_prefixed_str(buf, scan, 253, is_host_byte) else {
            scan += 1;
            continue;
        };
        // A real host contains a dot (IPv4 or FQDN) and at least one alnum.
        let plausible = host.contains('.') && host.chars().any(|c| c.is_ascii_alphanumeric());
        let port = read_u32_be(buf, after_host).unwrap_or(0);
        if !plausible || port == 0 || port > 65535 {
            scan += 1;
            continue;
        }
        // Username = next short printable string within a small window.
        let mut user = String::new();
        let mut p = after_host + 4;
        let limit = (p + 64).min(buf.len());
        while p + 4 < limit {
            if let Some((s, _)) = read_prefixed_str(buf, p, 64, |b| {
                b.is_ascii_graphic() && b != b',' && b != b':'
            }) {
                user = s;
                break;
            }
            p += 1;
        }
        return TlpProfile {
            found: true,
            host,
            port: port as u16,
            user,
        };
    }
    none
}

/// Parse a Bitvise `.tlp` profile file into SSH connection fields.
#[tauri::command(rename_all = "camelCase")]
pub fn parse_tlp(path: String) -> Result<TlpProfile, String> {
    let buf = std::fs::read(&path).map_err(|e| e.to_string())?;
    let prof = parse_tlp_bytes(&buf);
    if !prof.found {
        return Err("no SSH host found in profile".into());
    }
    Ok(prof)
}
