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
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferProgress {
    pane_id: String,
    name: String,
    done: u64,
    total: u64,
}

enum SshOp {
    Write(Vec<u8>),
    Resize(u16, u16),
    Kill,
}

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

    let secret = get_secret(pane_id);
    if cfg.auth == "key" {
        let key = cfg.key_path.clone().unwrap_or_default();
        if key.is_empty() {
            return Err("chưa chọn file private key".into());
        }
        sess.userauth_pubkey_file(&cfg.user, None, Path::new(&key), secret.as_deref())
            .map_err(|e| format!("xác thực bằng key thất bại: {e}"))?;
    } else {
        let pass = secret.ok_or("chưa lưu mật khẩu cho terminal này")?;
        sess.userauth_password(&cfg.user, &pass)
            .map_err(|e| format!("sai mật khẩu hoặc server từ chối: {e}"))?;
    }
    if !sess.authenticated() {
        return Err("xác thực thất bại".into());
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
    // freezes when a host is unreachable or the server never answers.
    std::thread::spawn(move || {
        // Surface a connection/setup error into the terminal, then exit the pane.
        let fail = |on_event: &Channel<PtyEvent>, msg: String| {
            let line = format!("\r\n\x1b[31m{msg}\x1b[0m\r\n");
            let _ = on_event.send(PtyEvent::Data { data: line.into_bytes() });
            let _ = on_event.send(PtyEvent::Exit { code: -1 });
        };

        let sess = match connect(&app, &pane_id, &cfg) {
            Ok(s) => s,
            Err(e) => {
                fail(&on_event, e);
                terms.lock().unwrap().remove(&pane_id);
                return;
            }
        };
        let mut ch = match sess
            .channel_session()
            .and_then(|mut ch| {
                ch.request_pty("xterm-256color", None, Some((cols as u32, rows as u32, 0, 0)))?;
                ch.shell()?;
                Ok(ch)
            }) {
            Ok(ch) => ch,
            Err(e) => {
                fail(&on_event, format!("mở shell từ xa lỗi: {e}"));
                terms.lock().unwrap().remove(&pane_id);
                return;
            }
        };

        if let Some(c) = command {
            if !c.trim().is_empty() {
                let _ = ch.write_all(format!("{c}\n").as_bytes());
                let _ = ch.flush();
            }
        }

        sess.set_blocking(false);

        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        'outer: loop {
            // 1) queued ops from the frontend
            loop {
                match rx.try_recv() {
                    Ok(SshOp::Write(d)) => pending.extend_from_slice(&d),
                    Ok(SshOp::Resize(c, r)) => {
                        let _ = ch.request_pty_size(c as u32, r as u32, None, None);
                    }
                    Ok(SshOp::Kill) => break 'outer,
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => break 'outer,
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
                    Err(_) => break, // EAGAIN — retry next tick
                }
            }
            // 3) read output
            let mut read_any = false;
            match ch.read(&mut buf) {
                Ok(0) => {
                    if ch.eof() {
                        break 'outer;
                    }
                }
                Ok(n) => {
                    read_any = true;
                    if on_event
                        .send(PtyEvent::Data {
                            data: buf[..n].to_vec(),
                        })
                        .is_err()
                    {
                        break 'outer;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => break 'outer,
            }
            if !read_any && !wrote {
                std::thread::sleep(Duration::from_millis(8));
            }
        }
        sess.set_blocking(true);
        let _ = ch.close();
        let _ = ch.wait_close();
        let code = ch.exit_status().unwrap_or(0);
        let _ = on_event.send(PtyEvent::Exit { code });
        terms.lock().unwrap().remove(&pane_id);
    });

    Ok(())
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

fn perms_string(mode: u32, is_dir: bool) -> String {
    let mut s = String::with_capacity(10);
    s.push(if is_dir { 'd' } else { '-' });
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
            Some(FileEntry {
                name,
                size: st.size.unwrap_or(0),
                is_dir,
                modified: st.mtime.unwrap_or(0),
                perms: perms_string(st.perm.unwrap_or(0), is_dir),
            })
        })
        .collect())
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
