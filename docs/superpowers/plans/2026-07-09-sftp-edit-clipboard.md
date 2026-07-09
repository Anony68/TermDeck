# SFTP Edit-in-place + Clipboard + Properties Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring TermDeck's dual-pane file browser to Bitvise SFTP parity: Edit / Edit with… (external editor + auto-upload on save), Cut/Copy/Paste/Move, Properties, Open, Copy path, New file, and working local↔local copy.

**Architecture:** New Rust commands extend the existing `ssh.rs` command set (`fs_*`/`sftp_*`); a new `edit.rs` module uses the `notify` crate to watch temp copies of remote files and emit `edit://changed`, which a global frontend listener answers with `sftp_upload`. UI work extends `FilePanel`/`FileBrowser` following their existing menu/dialog/i18n patterns.

**Tech Stack:** Tauri v2 (Rust), React 18 + TypeScript + Vite, Zustand, ssh2 (libssh2), notify 6.

**Spec:** `docs/superpowers/specs/2026-07-09-sftp-edit-clipboard-design.md`

## Global Constraints

- Every new user-visible string gets a key in `src/i18n.ts` with BOTH `vi` and `en` values (the `TKey` type makes missing keys a compile error).
- Frontend verification = `npx tsc --noEmit` (repo has no JS test runner — do NOT add one). Rust verification = `cargo test --manifest-path src-tauri/Cargo.toml` and `cargo check --manifest-path src-tauri/Cargo.toml`.
- All Rust commands use `#[tauri::command(rename_all = "camelCase")]` when they have multi-word params.
- `FsBackend` funcs passed to `FilePanel` MUST be memoized in `FileBrowser` (they gate load effects; the host Pane re-renders every second).
- Background `std::process::Command` spawns on Windows need `CREATE_NO_WINDOW` (0x0800_0000) — but NOT editor launches (a console-subsystem editor should show its window).
- Error strings in Rust follow the existing style (Vietnamese fragments like `"mở file remote lỗi: {e}"` are the established pattern in ssh.rs — match it).
- Commit after each task with a `feat(fb): …` / `feat(rust): …` message ending in `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Rust local-FS commands (`fs_stat`, `fs_touch`, `fs_copy`, `fs_dir_size`)

**Files:**
- Modify: `src-tauri/src/ssh.rs` (append to the `// ---------- local filesystem` section, after `fs_home` ~line 941)
- Modify: `src-tauri/src/lib.rs:245-250` (register commands)
- Modify: `src/ipc/ssh.ts` (wrappers + `StatInfo` type)

**Interfaces:**
- Produces (Rust): `StatInfo` struct (shared with Task 2), commands `fs_stat(path) -> StatInfo`, `fs_touch(path)`, `fs_copy(from, to)` (single file, overwrites), `fs_dir_size(path) -> u64` (async, bounded 50k dirs).
- Produces (TS): `interface StatInfo { size: number; isDir: boolean; modified: number; created: number; accessed: number; readonly: boolean; hidden: boolean; mode: number; uid: number; gid: number; isSymlink: boolean; linkTarget: string }`, `fsStat(path)`, `fsTouch(path)`, `fsCopy(from, to)`, `fsDirSize(path)`.

- [ ] **Step 1: Write failing Rust tests** — append to the END of `src-tauri/src/ssh.rs`:

```rust
#[cfg(test)]
mod fs_tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("termdeck-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn touch_creates_and_refuses_overwrite() {
        let d = tmp("touch");
        let f = d.join("a.txt").to_string_lossy().into_owned();
        fs_touch(f.clone()).unwrap();
        assert!(std::path::Path::new(&f).exists());
        assert!(fs_touch(f).is_err(), "existing file must not be truncated");
    }

    #[test]
    fn copy_copies_bytes() {
        let d = tmp("copy");
        let a = d.join("a.bin");
        std::fs::write(&a, b"hello").unwrap();
        let b = d.join("b.bin");
        fs_copy(a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned()).unwrap();
        assert_eq!(std::fs::read(&b).unwrap(), b"hello");
    }

    #[test]
    fn dir_size_sums_recursively() {
        let d = tmp("size");
        std::fs::create_dir_all(d.join("sub")).unwrap();
        std::fs::write(d.join("a"), vec![0u8; 10]).unwrap();
        std::fs::write(d.join("sub/b"), vec![0u8; 32]).unwrap();
        assert_eq!(dir_size_sync(&d.to_string_lossy()), 42);
    }

    #[test]
    fn stat_reports_file() {
        let d = tmp("stat");
        let f = d.join("x.txt");
        std::fs::write(&f, b"12345").unwrap();
        let st = fs_stat(f.to_string_lossy().into_owned()).unwrap();
        assert_eq!(st.size, 5);
        assert!(!st.is_dir);
        assert!(st.modified > 0);
    }
}
```

- [ ] **Step 2: Run tests, verify they FAIL to compile** — `cargo test --manifest-path src-tauri/Cargo.toml fs_tests` → error: `fs_touch`/`fs_copy`/`dir_size_sync`/`fs_stat` not found.

- [ ] **Step 3: Implement** — insert after `fs_home` in `ssh.rs`:

```rust
/// Full metadata for the Properties dialog. Shared by fs_stat and sftp_stat;
/// fields the platform can't provide are 0/false/"".
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatInfo {
    pub size: u64,
    pub is_dir: bool,
    pub modified: u64,
    pub created: u64,
    pub accessed: u64,
    pub readonly: bool,
    pub hidden: bool,
    /// Unix permission bits (remote only; 0 local).
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub is_symlink: bool,
    pub link_target: String,
}

#[tauri::command]
pub fn fs_stat(path: String) -> Result<StatInfo, String> {
    let p = Path::new(&path);
    let sym = std::fs::symlink_metadata(p).map_err(|e| e.to_string())?;
    let is_symlink = sym.file_type().is_symlink();
    let meta = std::fs::metadata(p).unwrap_or_else(|_| sym.clone());
    let secs = |t: std::io::Result<std::time::SystemTime>| {
        t.ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0)
    };
    let link_target = if is_symlink {
        std::fs::read_link(p).map(|t| t.to_string_lossy().into_owned()).unwrap_or_default()
    } else {
        String::new()
    };
    #[cfg(windows)]
    let hidden = {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x2 != 0 // FILE_ATTRIBUTE_HIDDEN
    };
    #[cfg(not(windows))]
    let hidden = p
        .file_name()
        .map(|n| n.to_string_lossy().starts_with('.'))
        .unwrap_or(false);
    Ok(StatInfo {
        size: meta.len(),
        is_dir: meta.is_dir(),
        modified: secs(meta.modified()),
        created: secs(meta.created()),
        accessed: secs(meta.accessed()),
        readonly: meta.permissions().readonly(),
        hidden,
        mode: 0,
        uid: 0,
        gid: 0,
        is_symlink,
        link_target,
    })
}

/// Create a new empty file; errors if it already exists (never truncates).
#[tauri::command]
pub fn fs_touch(path: String) -> Result<(), String> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map(|_| ())
        .map_err(|e| format!("tạo file lỗi: {e}"))
}

/// Copy ONE file (recursion is handled by the frontend transfer engine).
#[tauri::command]
pub fn fs_copy(from: String, to: String) -> Result<(), String> {
    std::fs::copy(&from, &to).map(|_| ()).map_err(|e| format!("chép file lỗi: {e}"))
}

fn dir_size_sync(path: &str) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![std::path::PathBuf::from(path)];
    let mut visited = 0u32;
    while let Some(dir) = stack.pop() {
        if visited >= 50_000 {
            break; // bound runaway trees
        }
        visited += 1;
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for ent in rd.flatten() {
            let Ok(meta) = ent.metadata() else { continue };
            if meta.is_dir() {
                stack.push(ent.path());
            } else {
                total += meta.len();
            }
        }
    }
    total
}

#[tauri::command(rename_all = "camelCase")]
pub async fn fs_dir_size(path: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(dir_size_sync(&path)))
        .await
        .map_err(|e| e.to_string())?
}
```

- [ ] **Step 4: Register in `lib.rs`** — add to `invoke_handler` after `ssh::fs_home,`:

```rust
            ssh::fs_stat,
            ssh::fs_touch,
            ssh::fs_copy,
            ssh::fs_dir_size,
```

- [ ] **Step 5: Run tests, verify PASS** — `cargo test --manifest-path src-tauri/Cargo.toml fs_tests` → 4 passed.

- [ ] **Step 6: TS wrappers** — in `src/ipc/ssh.ts` after `fsHome` (~line 192):

```ts
/** Full metadata for the Properties dialog (fields a side can't provide are 0/false/''). */
export interface StatInfo {
  size: number;
  isDir: boolean;
  modified: number;
  created: number;
  accessed: number;
  readonly: boolean;
  hidden: boolean;
  mode: number;
  uid: number;
  gid: number;
  isSymlink: boolean;
  linkTarget: string;
}

export async function fsStat(path: string): Promise<StatInfo> {
  return await invoke('fs_stat', { path });
}
export async function fsTouch(path: string): Promise<void> {
  await invoke('fs_touch', { path });
}
export async function fsCopy(from: string, to: string): Promise<void> {
  await invoke('fs_copy', { from, to });
}
export async function fsDirSize(path: string): Promise<number> {
  return await invoke('fs_dir_size', { path });
}
```

- [ ] **Step 7: Verify** — `npx tsc --noEmit` passes; `cargo check --manifest-path src-tauri/Cargo.toml` passes.

- [ ] **Step 8: Commit** — `git add src-tauri/src/ssh.rs src-tauri/src/lib.rs src/ipc/ssh.ts && git commit -m "feat(rust): fs_stat/fs_touch/fs_copy/fs_dir_size local FS commands"`

---

### Task 2: Rust SFTP commands (`sftp_stat`, `sftp_touch`, `sftp_copy`, `sftp_dir_size`)

**Files:**
- Modify: `src-tauri/src/ssh.rs` (append to the SFTP section, after `sftp_download` ~line 864)
- Modify: `src-tauri/src/lib.rs` (register)
- Modify: `src/ipc/ssh.ts` (wrappers)

**Interfaces:**
- Consumes: `StatInfo` struct from Task 1, `get_sftp` (ssh.rs:504), `TransferProgress` + `PROGRESS_STEP` (ssh.rs:52-59, 763).
- Produces (TS): `sftpStat(paneId, path) -> StatInfo`, `sftpTouch(paneId, path)`, `sftpCopy(paneId, from, to)` (emits `sftp://progress`), `sftpDirSize(paneId, path) -> number`.

- [ ] **Step 1: Implement** (no unit tests possible without a live server — verified by `cargo check` + Task 10 manual pass):

```rust
#[tauri::command(rename_all = "camelCase")]
pub fn sftp_stat(
    state: tauri::State<SshManager>,
    pane_id: String,
    path: String,
) -> Result<StatInfo, String> {
    let conn = get_sftp(&state, &pane_id)?;
    let conn = conn.lock().unwrap();
    let p = Path::new(&path);
    let lst = conn.sftp.lstat(p).map_err(|e| format!("đọc thuộc tính lỗi: {e}"))?;
    let is_symlink = lst.perm.unwrap_or(0) & 0o170000 == 0o120000;
    // For symlinks report the target's size/kind, but keep the link flag.
    let st = if is_symlink { conn.sftp.stat(p).unwrap_or(lst.clone()) } else { lst.clone() };
    let link_target = if is_symlink {
        conn.sftp
            .readlink(p)
            .map(|t| t.to_string_lossy().into_owned())
            .unwrap_or_default()
    } else {
        String::new()
    };
    Ok(StatInfo {
        size: st.size.unwrap_or(0),
        is_dir: st.is_dir(),
        modified: st.mtime.unwrap_or(0),
        created: 0,
        accessed: st.atime.unwrap_or(0),
        readonly: false,
        hidden: false,
        mode: st.perm.unwrap_or(0) & 0o777,
        uid: st.uid.unwrap_or(0),
        gid: st.gid.unwrap_or(0),
        is_symlink,
        link_target,
    })
}

/// Create a new empty remote file; errors if it already exists.
#[tauri::command(rename_all = "camelCase")]
pub fn sftp_touch(state: tauri::State<SshManager>, pane_id: String, path: String) -> Result<(), String> {
    use ssh2::{OpenFlags, OpenType};
    let conn = get_sftp(&state, &pane_id)?;
    let conn = conn.lock().unwrap();
    conn.sftp
        .open_mode(
            Path::new(&path),
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUSIVE,
            0o644,
            OpenType::File,
        )
        .map(|_| ())
        .map_err(|e| format!("tạo file lỗi: {e}"))
}

/// Copy ONE remote file to another remote path by streaming through the client
/// (SFTP has no server-side copy). Emits sftp://progress like upload/download.
#[tauri::command(rename_all = "camelCase")]
pub fn sftp_copy(
    app: AppHandle,
    state: tauri::State<SshManager>,
    pane_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let conn = get_sftp(&state, &pane_id)?;
    let conn = conn.lock().unwrap();
    let mut src = conn
        .sftp
        .open(Path::new(&from))
        .map_err(|e| format!("mở file remote lỗi: {e}"))?;
    let total = src.stat().ok().and_then(|s| s.size).unwrap_or(0);
    let mut dst = conn
        .sftp
        .create(Path::new(&to))
        .map_err(|e| format!("tạo file remote lỗi: {e}"))?;
    let name = Path::new(&from)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| from.clone());
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

/// Recursive size of a remote subtree (bounded like sftp_search).
#[tauri::command(rename_all = "camelCase")]
pub async fn sftp_dir_size(
    state: tauri::State<'_, SshManager>,
    pane_id: String,
    path: String,
) -> Result<u64, String> {
    let conn = get_sftp(&state, &pane_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = conn.lock().unwrap();
        let mut total = 0u64;
        let mut stack = vec![path];
        let mut visited = 0u32;
        while let Some(dir) = stack.pop() {
            if visited >= 8000 {
                break;
            }
            visited += 1;
            let list = match conn.sftp.readdir(Path::new(&dir)) {
                Ok(l) => l,
                Err(_) => continue,
            };
            for (p, st) in list {
                let is_symlink = st.perm.unwrap_or(0) & 0o170000 == 0o120000;
                if st.is_dir() && !is_symlink {
                    stack.push(p.to_string_lossy().into_owned());
                } else {
                    total += st.size.unwrap_or(0);
                }
            }
        }
        Ok(total)
    })
    .await
    .map_err(|e| e.to_string())?
}
```

- [ ] **Step 2: Register in `lib.rs`** — add after `ssh::sftp_download,`:

```rust
            ssh::sftp_stat,
            ssh::sftp_touch,
            ssh::sftp_copy,
            ssh::sftp_dir_size,
```

- [ ] **Step 3: TS wrappers** — in `src/ipc/ssh.ts` after `sftpDownload`:

```ts
export async function sftpStat(paneId: string, path: string): Promise<StatInfo> {
  return await invoke('sftp_stat', { paneId, path });
}
export async function sftpTouch(paneId: string, path: string): Promise<void> {
  await invoke('sftp_touch', { paneId, path });
}
export async function sftpCopy(paneId: string, from: string, to: string): Promise<void> {
  await invoke('sftp_copy', { paneId, from, to });
}
export async function sftpDirSize(paneId: string, path: string): Promise<number> {
  return await invoke('sftp_dir_size', { paneId, path });
}
```

- [ ] **Step 4: Verify** — `cargo check --manifest-path src-tauri/Cargo.toml` + `npx tsc --noEmit` pass. (If `OpenFlags::EXCLUSIVE` doesn't exist in ssh2 0.9, use `OpenFlags::EXCL`; check `cargo doc` or the error message — one of the two is the real name.)

- [ ] **Step 5: Commit** — `git add -A src-tauri/src src/ipc/ssh.ts && git commit -m "feat(rust): sftp_stat/sftp_touch/sftp_copy/sftp_dir_size"`

---

### Task 3: Rust edit module (notify watcher + editor launcher)

**Files:**
- Modify: `src-tauri/Cargo.toml` (add `notify = "6"` to `[dependencies]`)
- Create: `src-tauri/src/edit.rs`
- Modify: `src-tauri/src/lib.rs` (mod + manage + register + sweep in setup)
- Create: `src/ipc/edit.ts`

**Interfaces:**
- Produces (Rust): `EditManager` state; commands `edit_prepare(editId, fileName) -> String` (temp file path), `edit_open(path, app: Option<String>)`, `edit_watch(editId, path)`, `edit_unwatch(editId)`; event `edit://changed { editId }` (debounced 400 ms); `edit::sweep_stale()` called in setup.
- Produces (TS): `editPrepare`, `editOpen`, `editWatch`, `editUnwatch`, `onEditChanged(cb) -> unlisten`.

- [ ] **Step 1: Add dependency** — in `src-tauri/Cargo.toml` `[dependencies]`:

```toml
notify = "6"
```

- [ ] **Step 2: Write `src-tauri/src/edit.rs`:**

```rust
// Edit-in-place support: temp copies of remote files are watched with `notify`;
// each save burst emits ONE debounced `edit://changed` and the frontend re-uploads.
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct EditManager {
    /// Dropping a watcher stops it AND closes its channel, ending the debounce thread.
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl EditManager {
    pub fn new() -> Self {
        Self { watchers: Mutex::new(HashMap::new()) }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EditChanged {
    edit_id: String,
}

fn edit_root() -> PathBuf {
    std::env::temp_dir().join("TermDeck-edit")
}

/// Create the per-edit temp dir and return the full temp-file path (keeps the
/// original filename so editors detect the file type).
#[tauri::command(rename_all = "camelCase")]
pub fn edit_prepare(edit_id: String, file_name: String) -> Result<String, String> {
    let dir = edit_root().join(&edit_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(&file_name).to_string_lossy().into_owned())
}

/// Launch an editor on `path`: a specific exe when `app` is set, else the OS
/// default for the extension. No CREATE_NO_WINDOW: a console-subsystem editor
/// must be allowed to show its window; GUI editors never open a console.
#[tauri::command(rename_all = "camelCase")]
pub fn edit_open(path: String, app: Option<String>) -> Result<(), String> {
    match app.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(exe) => std::process::Command::new(exe)
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("mở editor lỗi: {e}")),
        None => tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string()),
    }
}

/// Watch the temp file's parent dir (editors often save via rename-replace, so
/// watching the file inode directly would go stale). Debounce: emit 400 ms
/// after the last matching event.
#[tauri::command(rename_all = "camelCase")]
pub fn edit_watch(
    app: AppHandle,
    state: tauri::State<EditManager>,
    edit_id: String,
    path: String,
) -> Result<(), String> {
    let file = PathBuf::from(&path);
    let parent = file.parent().ok_or("đường dẫn không hợp lệ")?.to_path_buf();
    let fname = file.file_name().ok_or("đường dẫn không hợp lệ")?.to_os_string();

    let (tx, rx) = channel::<()>();
    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        if let Ok(ev) = res {
            use notify::EventKind;
            let relevant = matches!(ev.kind, EventKind::Modify(_) | EventKind::Create(_) | EventKind::Any);
            let hit = ev.paths.iter().any(|p| p.file_name() == Some(fname.as_os_str()));
            if relevant && hit {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    // Debounce thread: exits when the watcher (and thus tx) is dropped.
    {
        let id = edit_id.clone();
        std::thread::spawn(move || loop {
            match rx.recv() {
                Err(_) => break, // unwatched
                Ok(()) => {
                    loop {
                        match rx.recv_timeout(Duration::from_millis(400)) {
                            Ok(()) => continue, // still writing — keep waiting
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => return,
                        }
                    }
                    let _ = app.emit("edit://changed", EditChanged { edit_id: id.clone() });
                }
            }
        });
    }

    // Replacing an existing watcher for this id drops (stops) the old one.
    state.watchers.lock().unwrap().insert(edit_id, watcher);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn edit_unwatch(state: tauri::State<EditManager>, edit_id: String) -> Result<(), String> {
    state.watchers.lock().unwrap().remove(&edit_id);
    Ok(())
}

/// Delete stale per-edit temp dirs (older than 7 days). Called once at startup.
pub fn sweep_stale() {
    let Ok(rd) = std::fs::read_dir(edit_root()) else { return };
    let week = Duration::from_secs(7 * 24 * 3600);
    for ent in rd.flatten() {
        let old = ent
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|d| d > week)
            .unwrap_or(false);
        if old {
            let _ = std::fs::remove_dir_all(ent.path());
        }
    }
}

#[cfg(test)]
mod edit_tests {
    use super::*;

    #[test]
    fn prepare_creates_dir_and_keeps_filename() {
        let p = edit_prepare("test-prep-1".into(), "notes.txt".into()).unwrap();
        assert!(p.ends_with("notes.txt"));
        assert!(std::path::Path::new(&p).parent().unwrap().exists());
        let _ = std::fs::remove_dir_all(edit_root().join("test-prep-1"));
    }
}
```

- [ ] **Step 3: Wire into `lib.rs`** — add `mod edit;` next to the other `mod` lines; in the builder chain add `.manage(edit::EditManager::new())` after `.manage(SshManager::new())`; inside `.setup(...)` add `edit::sweep_stale();` before `Ok(())`; register commands:

```rust
            edit::edit_prepare,
            edit::edit_open,
            edit::edit_watch,
            edit::edit_unwatch,
```

- [ ] **Step 4: Run** — `cargo test --manifest-path src-tauri/Cargo.toml edit_tests` → 1 passed; `cargo check` passes. (If `tauri_plugin_opener::open_path`'s second arg type differs, the compile error will show the expected `Option<impl Into<String>>` — adjust to `None::<String>`.)

- [ ] **Step 5: Create `src/ipc/edit.ts`:**

```ts
// IPC for edit-in-place: temp-file prep, editor launch, save-watcher events.
import { invoke } from '@tauri-apps/api/core';
import { IS_TAURI } from './env';

export async function editPrepare(editId: string, fileName: string): Promise<string> {
  return await invoke('edit_prepare', { editId, fileName });
}
/** Open with a specific exe, or the OS default app when `app` is undefined. */
export async function editOpen(path: string, app?: string): Promise<void> {
  await invoke('edit_open', { path, app: app ?? null });
}
export async function editWatch(editId: string, path: string): Promise<void> {
  await invoke('edit_watch', { editId, path });
}
export function editUnwatch(editId: string): void {
  if (!IS_TAURI) return;
  void invoke('edit_unwatch', { editId });
}
/** Fires (debounced) every time a watched temp file is saved by the editor. */
export async function onEditChanged(cb: (editId: string) => void): Promise<() => void> {
  if (!IS_TAURI) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<{ editId: string }>('edit://changed', (e) => cb(e.payload.editId));
}
```

- [ ] **Step 6: Verify** — `npx tsc --noEmit` passes.

- [ ] **Step 7: Commit** — `git add -A src-tauri src/ipc/edit.ts && git commit -m "feat(rust): edit-in-place watcher module (notify) + editor launcher"`

---

### Task 4: Editor settings (types, store, Settings UI, i18n)

**Files:**
- Modify: `src/types.ts:81-96` (`Settings` + new `EditorApp`)
- Modify: `src/state/store.ts:30-42` (`DEFAULT_SETTINGS`)
- Modify: `src/settings/SettingsWindow.tsx` (nav + new `EditorSection`)
- Modify: `src/i18n.ts` (keys)

**Interfaces:**
- Produces: `Settings.defaultEditor: string` ('' = OS default), `Settings.editors: EditorApp[]`, `interface EditorApp { name: string; path: string }`. NO STORE_VERSION bump — `hydrate()` merges `{...DEFAULT_SETTINGS, ...persisted.settings}` (store.ts:306).
- Consumes: `updateSettings(patch)` (store.ts:745), `ToggleRow`-style section pattern, `useT`.

- [ ] **Step 1: types.ts** — add above `Settings`:

```ts
/** An external editor the user registered for "Edit with…". */
export interface EditorApp {
  name: string;
  path: string;
}
```

and inside `Settings`:

```ts
  /** Exe used by "Edit" ('' = the OS default app for the extension). */
  defaultEditor: string;
  /** Editors offered in the "Edit with…" submenu. */
  editors: EditorApp[];
```

- [ ] **Step 2: store.ts** — `DEFAULT_SETTINGS` gains `defaultEditor: '', editors: [],`.

- [ ] **Step 3: i18n keys** — add to the dict in `src/i18n.ts` (grouped near the other `set.*` keys):

```ts
  'set.nav.editor': { vi: 'Trình soạn thảo', en: 'Editor' },
  'set.editorDefault': { vi: 'Editor mặc định', en: 'Default editor' },
  'set.editorDefaultHint': {
    vi: 'Dùng cho nút "Sửa". Để trống = mở bằng ứng dụng Windows gắn với đuôi file.',
    en: 'Used by "Edit". Leave empty to open with the OS-default app for the file type.',
  },
  'set.editorBrowse': { vi: 'Chọn…', en: 'Browse…' },
  'set.editorClear': { vi: 'Xóa', en: 'Clear' },
  'set.editorList': { vi: 'Danh sách "Sửa bằng…"', en: '"Edit with…" list' },
  'set.editorListHint': {
    vi: 'Các editor hiện trong menu chuột phải "Sửa bằng…".',
    en: 'Editors shown in the right-click "Edit with…" submenu.',
  },
  'set.editorAdd': { vi: 'Thêm editor…', en: 'Add editor…' },
  'set.editorEmpty': { vi: 'Chưa có editor nào.', en: 'No editors yet.' },
```

- [ ] **Step 4: SettingsWindow.tsx** — extend `Section` union with `'editor'`, add `{ id: 'editor', key: 'set.nav.editor' }` to `NAV` after `shells`, add `{section === 'editor' && <EditorSection />}` to the render switch, and add the section component (place near `ShellsSection`):

```tsx
/** Pick an executable with the OS file dialog; returns null when cancelled. */
async function pickExe(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const sel = await open({
    multiple: false,
    // IS_WIN is already imported at the top of SettingsWindow.tsx (from '../shells').
    filters: IS_WIN ? [{ name: 'Program', extensions: ['exe', 'cmd', 'bat'] }] : undefined,
  });
  return typeof sel === 'string' ? sel : null;
}

/** Filename without extension — the display name for a picked editor exe. */
export function editorNameOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function EditorSection() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const t = useT();
  return (
    <div>
      <div className="set-h">{t('set.editorDefault')}</div>
      <div style={{ font: '400 11px var(--font-ui)', color: 'var(--text-muted)', marginBottom: 8 }}>
        {t('set.editorDefaultHint')}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 20 }}>
        <input
          className="field mono"
          value={settings.defaultEditor}
          onChange={(e) => updateSettings({ defaultEditor: e.target.value })}
          placeholder="C:\\Program Files\\Notepad++\\notepad++.exe"
          style={{ flex: 1, padding: '6px 9px', fontSize: 11.5 }}
        />
        <button
          className="ghost-btn"
          onClick={() => void pickExe().then((p) => p && updateSettings({ defaultEditor: p }))}
        >
          {t('set.editorBrowse')}
        </button>
        {settings.defaultEditor && (
          <button className="ghost-btn" onClick={() => updateSettings({ defaultEditor: '' })}>
            {t('set.editorClear')}
          </button>
        )}
      </div>

      <div className="set-h">{t('set.editorList')}</div>
      <div style={{ font: '400 11px var(--font-ui)', color: 'var(--text-muted)', marginBottom: 8 }}>
        {t('set.editorListHint')}
      </div>
      {settings.editors.length === 0 && (
        <div style={{ font: '400 11px var(--font-ui)', color: 'var(--text-faint)', marginBottom: 8 }}>
          {t('set.editorEmpty')}
        </div>
      )}
      {settings.editors.map((ed, i) => (
        <div key={`${ed.path}-${i}`} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <span style={{ font: '600 11.5px var(--font-ui)', color: 'var(--text)', width: 120 }}>{ed.name}</span>
          <span
            className="mono"
            style={{ flex: 1, font: '400 10.5px var(--font-mono)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={ed.path}
          >
            {ed.path}
          </span>
          <button
            className="ghost-btn"
            onClick={() => updateSettings({ editors: settings.editors.filter((_, j) => j !== i) })}
          >
            <IconClose size={12} />
          </button>
        </div>
      ))}
      <button
        className="ghost-btn"
        style={{ marginTop: 6 }}
        onClick={() =>
          void pickExe().then((p) => {
            if (!p) return;
            const editors = useStore.getState().settings.editors;
            if (editors.some((e) => e.path === p)) return;
            updateSettings({ editors: [...editors, { name: editorNameOf(p), path: p }] });
          })
        }
      >
        {t('set.editorAdd')}
      </button>
    </div>
  );
}
```

(Adapt the `set-h` heading class to whatever `ShellsSection` actually uses for its section headings — copy its exact heading markup.)

- [ ] **Step 5: Verify** — `npx tsc --noEmit` passes. Run `npm run tauri dev` briefly: Settings → Editor section renders, Browse picks an exe, values persist after app restart.

- [ ] **Step 6: Commit** — `git add src/types.ts src/state/store.ts src/settings/SettingsWindow.tsx src/i18n.ts && git commit -m "feat(settings): default editor + Edit-with editors list"`

---

### Task 5: ContextMenu submenu support

**Files:**
- Modify: `src/components/ContextMenu.tsx`

**Interfaces:**
- Produces: `MenuItem.children?: MenuItem[]` — an item with `children` renders a "▸" arrow and opens a nested menu on hover; clicking a child runs its `onClick` and closes the whole menu. Existing flat usage is unaffected.

- [ ] **Step 1: Extend the interface:**

```ts
export interface MenuItem {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  /** Submenu items — this item then opens a nested menu on hover. */
  children?: MenuItem[];
}
```

- [ ] **Step 2: Render submenus** — replace the `items.map(...)` body:

```tsx
  const [sub, setSub] = useState<number | null>(null);
  // …existing effect + positioning unchanged…

  const renderItem = (it: MenuItem, i: number) =>
    it.separator ? (
      <div key={i} className="menu-sep" />
    ) : (
      <div
        key={i}
        className={`menu-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}`}
        style={it.children ? { position: 'relative' } : undefined}
        onMouseEnter={() => setSub(it.children && !it.disabled ? i : null)}
        onClick={() => {
          if (it.disabled || it.children) return;
          onClose();
          it.onClick?.();
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          {it.label}
          {it.children && <span style={{ color: 'var(--text-muted)' }}>▸</span>}
        </span>
        {it.children && sub === i && (
          <div
            style={{
              position: 'absolute',
              left: '100%',
              top: -4,
              zIndex: 101,
              minWidth: 190,
              background: 'var(--surface-2)',
              border: '1px solid var(--border-3)',
              borderRadius: 8,
              boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
              padding: 4,
            }}
          >
            {it.children.map((c, j) =>
              c.separator ? (
                <div key={j} className="menu-sep" />
              ) : (
                <div
                  key={j}
                  className={`menu-item${c.danger ? ' danger' : ''}${c.disabled ? ' disabled' : ''}`}
                  onClick={() => {
                    if (c.disabled) return;
                    onClose();
                    c.onClick?.();
                  }}
                >
                  {c.label}
                </div>
              )
            )}
          </div>
        )}
      </div>
    );
```

(add `useState` to the react import). Items map becomes `{items.map(renderItem)}`.

- [ ] **Step 3: Verify** — `npx tsc --noEmit` passes (submenu is exercised visually in Task 7).

- [ ] **Step 4: Commit** — `git add src/components/ContextMenu.tsx && git commit -m "feat(ui): context-menu submenu support"`

---

### Task 6: Edits store + global auto-upload + "✎ editing" chip

**Files:**
- Create: `src/state/edits.ts`
- Modify: `src/App.tsx` (wire the global listener once)
- Modify: `src/components/FileBrowser.tsx` (chip + popover in the transfer status bar, ~line 557)
- Modify: `src/i18n.ts` (keys)
- Modify: `src/components/icons.tsx` (add `IconPencil` from lucide `Pencil`, same pattern as existing icons)

**Interfaces:**
- Consumes: `editPrepare/editOpen/editWatch/editUnwatch/onEditChanged` (Task 3), `sftpUpload/sftpDownload` (ssh.ts), `joinPath` (pathUtils).
- Produces: `useEdits` zustand store (`edits: Record<string, EditRecord>`); `startEdit(o)` — the ONE entry point Tasks 7 uses; `uploadNow(editId)`, `redownload(editId)`, `stopEdit(editId)`, `wireEditUploads()`.

- [ ] **Step 1: Create `src/state/edits.ts`:**

```ts
// Edit-in-place state: which files are open in an external editor, and the
// auto-upload pump that answers `edit://changed` events. Kept outside the main
// store — runtime-only, never persisted.
import { create } from 'zustand';
import { editOpen, editPrepare, editUnwatch, editWatch, onEditChanged } from '../ipc/edit';
import { sftpDownload, sftpUpload } from '../ipc/ssh';
import { joinPath } from '../components/pathUtils';

export interface EditRecord {
  editId: string;
  paneId: string;
  /** Remote path the temp file mirrors ('' would mean local — local edits are not tracked). */
  remotePath: string;
  tempPath: string;
  name: string;
  /** ms epoch of the last successful upload (0 = never). */
  lastUpload: number;
  uploading: boolean;
  /** A save arrived while uploading — re-upload when done. */
  queued: boolean;
  error: string | null;
}

interface EditsState {
  edits: Record<string, EditRecord>;
  upsert: (r: EditRecord) => void;
  patch: (editId: string, p: Partial<EditRecord>) => void;
  remove: (editId: string) => void;
}

export const useEdits = create<EditsState>((set) => ({
  edits: {},
  upsert: (r) => set((s) => ({ edits: { ...s.edits, [r.editId]: r } })),
  patch: (editId, p) =>
    set((s) =>
      s.edits[editId] ? { edits: { ...s.edits, [editId]: { ...s.edits[editId], ...p } } } : s
    ),
  remove: (editId) =>
    set((s) => {
      const next = { ...s.edits };
      delete next[editId];
      return { edits: next };
    }),
}));

/**
 * Open a file in an external editor. Local files open directly (saving IS
 * saving). Remote files download to %TEMP%/TermDeck-edit/<editId>/<name>,
 * open, and are watched — every save re-uploads (last-write-wins).
 * `app` = exe path; undefined = OS-default app.
 */
export async function startEdit(o: {
  paneId: string;
  remote: boolean;
  dir: string;
  name: string;
  sep: string;
  app?: string;
}): Promise<void> {
  const full = joinPath(o.dir, o.name, o.sep);
  if (!o.remote) {
    await editOpen(full, o.app);
    return;
  }
  // Re-editing the same remote file reuses its temp copy + watcher (never
  // clobbers unsaved editor state; use redownload() to refresh explicitly).
  const existing = Object.values(useEdits.getState().edits).find(
    (e) => e.paneId === o.paneId && e.remotePath === full
  );
  const editId = existing?.editId ?? `${o.paneId}-${Date.now().toString(36)}`;
  let temp = existing?.tempPath;
  if (!temp) {
    temp = await editPrepare(editId, o.name);
    await sftpDownload(o.paneId, full, temp);
    await editWatch(editId, temp);
  }
  useEdits.getState().upsert({
    editId,
    paneId: o.paneId,
    remotePath: full,
    tempPath: temp,
    name: o.name,
    lastUpload: existing?.lastUpload ?? 0,
    uploading: false,
    queued: false,
    error: existing?.error ?? null,
  });
  await editOpen(temp, o.app);
}

/** Upload the temp copy now (used by the change event AND the chip's retry). */
export async function uploadNow(editId: string): Promise<void> {
  const st = useEdits.getState();
  const rec = st.edits[editId];
  if (!rec) return;
  if (rec.uploading) {
    st.patch(editId, { queued: true });
    return;
  }
  st.patch(editId, { uploading: true, queued: false, error: null });
  try {
    await sftpUpload(rec.paneId, rec.tempPath, rec.remotePath);
    useEdits.getState().patch(editId, { uploading: false, lastUpload: Date.now() });
  } catch (e) {
    useEdits.getState().patch(editId, { uploading: false, error: String(e) });
  }
  if (useEdits.getState().edits[editId]?.queued) await uploadNow(editId);
}

/** Re-download the remote file over the temp copy (explicit refresh). */
export async function redownload(editId: string): Promise<void> {
  const rec = useEdits.getState().edits[editId];
  if (!rec) return;
  await sftpDownload(rec.paneId, rec.remotePath, rec.tempPath);
}

export function stopEdit(editId: string): void {
  editUnwatch(editId);
  useEdits.getState().remove(editId);
}

/** Stop every edit belonging to a pane (called when the pane is removed). */
export function stopEditsForPane(paneId: string): void {
  for (const e of Object.values(useEdits.getState().edits)) {
    if (e.paneId === paneId) stopEdit(e.editId);
  }
}

let wired = false;
/** Subscribe ONCE (App mount) — survives FileBrowser unmounts on tab switches. */
export function wireEditUploads(): void {
  if (wired) return;
  wired = true;
  void onEditChanged((editId) => void uploadNow(editId));
}
```

- [ ] **Step 1b: stop watchers on pane removal** — in `src/state/store.ts`, inside the `removePane` action (find it with `Grep "removePane:"`), add `stopEditsForPane(paneId);` next to the existing `killSession`/`secretDelete` cleanup, importing `{ stopEditsForPane }` from `./edits`. (edits.ts does not import store.ts, so no import cycle.)

- [ ] **Step 2: Wire in `src/App.tsx`** — add near the other top-level effects:

```ts
import { wireEditUploads } from './state/edits';
// inside the App component:
useEffect(() => {
  wireEditUploads();
}, []);
```

- [ ] **Step 3: `IconPencil`** — in `src/components/icons.tsx`, add an export following the file's existing lucide-wrapper pattern, using lucide-react's `Pencil` (copy the exact wrapper shape of a neighbor like `IconRefresh`).

- [ ] **Step 4: i18n keys:**

```ts
  'fb.editingN': { vi: 'Đang sửa {n}', en: 'Editing {n}' },
  'fb.editUploaded': { vi: 'đã upload {time}', en: 'uploaded {time}' },
  'fb.editNever': { vi: 'chưa upload', en: 'not uploaded yet' },
  'fb.editUploading': { vi: 'đang upload…', en: 'uploading…' },
  'fb.editReupload': { vi: 'Upload lại', en: 'Re-upload' },
  'fb.editRedownload': { vi: 'Tải lại về', en: 'Re-download' },
  'fb.editStop': { vi: 'Dừng theo dõi', en: 'Stop watching' },
```

- [ ] **Step 5: Chip + popover in `FileBrowser.tsx`** — read the slice and render at the START of the transfer status bar (before the bi-sync button, ~line 557):

```tsx
import { useEdits, uploadNow, redownload, stopEdit } from '../state/edits';
import { IconPencil } from './icons';
// inside FileBrowser():
const edits = useEdits((s) => s.edits);
const myEdits = Object.values(edits).filter((e) => e.paneId === pane.id);
const editErr = myEdits.some((e) => e.error);
const [editsOpen, setEditsOpen] = useState(false);
```

```tsx
        {myEdits.length > 0 && (
          <button
            className="fb-sync-btn"
            style={{
              flex: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              ...(editErr ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : {}),
            }}
            onClick={() => setEditsOpen((v) => !v)}
          >
            <IconPencil size={12} />
            {t('fb.editingN', { n: myEdits.length })}
          </button>
        )}
```

Popover (sibling of the other overlay dialogs at the bottom of the JSX, closes on backdrop click):

```tsx
      {editsOpen && (
        <div
          onMouseDown={() => setEditsOpen(false)}
          style={{ position: 'absolute', inset: 0, zIndex: 46 }}
        >
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              left: 10,
              bottom: 32,
              width: 380,
              maxHeight: 260,
              overflow: 'auto',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-3)',
              borderRadius: 10,
              boxShadow: '0 16px 40px rgba(0,0,0,0.55)',
              padding: 8,
            }}
          >
            {myEdits.map((ed) => (
              <div key={ed.editId} style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ font: '600 11.5px var(--font-ui)', color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={ed.remotePath}>
                    {ed.name}
                  </span>
                  <span style={{ font: '400 10px var(--font-mono)', color: ed.error ? 'var(--danger)' : 'var(--text-muted)' }}>
                    {ed.uploading
                      ? t('fb.editUploading')
                      : ed.error
                        ? ed.error
                        : ed.lastUpload
                          ? t('fb.editUploaded', { time: new Date(ed.lastUpload).toLocaleTimeString() })
                          : t('fb.editNever')}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  <button className="ghost-btn" style={{ fontSize: 10.5 }} onClick={() => void uploadNow(ed.editId)}>
                    {t('fb.editReupload')}
                  </button>
                  <button className="ghost-btn" style={{ fontSize: 10.5 }} onClick={() => void redownload(ed.editId)}>
                    {t('fb.editRedownload')}
                  </button>
                  <button className="ghost-btn" style={{ fontSize: 10.5, color: 'var(--danger)' }} onClick={() => stopEdit(ed.editId)}>
                    {t('fb.editStop')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
```

- [ ] **Step 6: Verify** — `npx tsc --noEmit` passes.

- [ ] **Step 7: Commit** — `git add src/state/edits.ts src/App.tsx src/components/FileBrowser.tsx src/components/icons.tsx src/i18n.ts && git commit -m "feat(fb): edit-in-place state, auto-upload pump, editing chip"`

---

### Task 7: FilePanel — Edit / Edit with… / Open / Copy path / New file

**Files:**
- Modify: `src/components/FilePanel.tsx` (FsBackend + props + menu + double-click + doNewFile)
- Modify: `src/components/FileBrowser.tsx` (backends gain `touch`; new panel props wired)
- Modify: `src/i18n.ts`

**Interfaces:**
- Consumes: `startEdit` (Task 6), `editOpen` (Task 3), `fsTouch/sftpTouch` (Tasks 1-2), `copyText` from `src/ipc/clipboard.ts`, submenu `children` (Task 5), `editorNameOf` + `pickExe` pattern (Task 4).
- Produces (FilePanel props consumed by Task 8/9 too):
  - `FsBackend.touch: (path: string) => Promise<void>` (now REQUIRED on both backends)
  - `onEditFile?: (entry: FileEntry, dir: string, app?: string) => void`
  - `onOpenFile?: (entry: FileEntry, dir: string) => void`

- [ ] **Step 1: FsBackend + props** — in `FilePanel.tsx` add to `FsBackend`:

```ts
  /** Create a new empty file (errors if the name exists). */
  touch: (path: string) => Promise<void>;
```

and new props on `FilePanel`:

```ts
  /** Open a file for editing (app = specific exe; undefined = default-editor resolution). */
  onEditFile?: (entry: FileEntry, dir: string, app?: string) => void;
  /** Open a file with the platform handler (double-click / menu "Open"). */
  onOpenFile?: (entry: FileEntry, dir: string) => void;
```

- [ ] **Step 2: double-click opens files** — change `openEntry`:

```ts
  const openEntry = (e: FileEntry) => {
    if (e.isDir) go(joinPath(path, e.name, backend.sep));
    else onOpenFile?.(e, path);
  };
```

- [ ] **Step 3: doNewFile** — next to `doMkdir`:

```ts
  const doNewFile = () => {
    setMenu(null);
    setAsk({
      label: t('fb.promptNewFile'),
      draft: '',
      onOk: async (name) => {
        if (!name.trim()) return;
        try {
          await backend.touch(joinPath(path, name.trim(), backend.sep));
          await load(path);
        } catch (e) {
          setNotice(t('fb.errNewFile', { err: String(e) }));
        }
      },
    });
  };
```

- [ ] **Step 4: menu items** — FilePanel reads editor settings itself:

```ts
import { useStore } from '../state/store';
import { copyText } from '../ipc/clipboard';
// inside FilePanel():
const defaultEditor = useStore((s) => s.settings.defaultEditor);
const editors = useStore((s) => s.settings.editors);
const updateSettings = useStore((s) => s.updateSettings);
```

Rebuild `menuItems()` in this order (spec §6; Cut/Copy/Paste slots come in Task 8 — leave a `// clipboard items inserted in Task 8` marker where shown):

```ts
  const menuItems = (): MenuItem[] => {
    const sel = selectedEntries();
    const target = menu?.entry;
    const list = target && !selected.has(target.name) ? [target] : sel;
    const isFile = !!target && !target.isDir;
    const fullOf = (e: FileEntry) => joinPath(path, e.name, backend.sep);
    return [
      { label: transferLabel, disabled: list.length === 0, onClick: () => onTransfer(list, path) },
      { label: t('fb.open'), disabled: !target, onClick: () => target && openEntry(target) },
      {
        label: t('fb.edit'),
        disabled: !isFile || !onEditFile,
        onClick: () => target && onEditFile?.(target, path, defaultEditor || undefined),
      },
      {
        label: t('fb.editWith'),
        disabled: !isFile || !onEditFile,
        children: [
          ...editors.map((ed) => ({
            label: ed.name,
            onClick: () => target && onEditFile?.(target, path, ed.path),
          })),
          ...(editors.length ? [{ label: '', separator: true }] : []),
          {
            label: t('fb.editBrowse'),
            onClick: async () => {
              const { open } = await import('@tauri-apps/plugin-dialog');
              const p = await open({ multiple: false });
              if (typeof p !== 'string' || !target) return;
              const base = p.split(/[\\/]/).pop() ?? p;
              const dot = base.lastIndexOf('.');
              const name = dot > 0 ? base.slice(0, dot) : base;
              const cur = useStore.getState().settings.editors;
              if (!cur.some((e) => e.path === p)) updateSettings({ editors: [...cur, { name, path: p }] });
              onEditFile?.(target, path, p);
            },
          },
        ],
      },
      { label: '', separator: true },
      // clipboard items inserted in Task 8
      { label: t('fb.rename'), disabled: !target, onClick: () => target && startRename(target) },
      {
        label: t('fb.delete'),
        danger: true,
        disabled: list.length === 0,
        onClick: () => list.length && setConfirmDel(list),
      },
      { label: '', separator: true },
      { label: t('fb.newFile'), onClick: doNewFile },
      { label: t('fb.newFolder'), onClick: doMkdir },
      { label: '', separator: true },
      {
        label: t('fb.copyPath'),
        disabled: !target,
        onClick: () => target && void copyText(fullOf(target)),
      },
      ...(backend.chmod
        ? [{ label: t('fb.chmod'), disabled: !target, onClick: () => target && doChmod(target) }]
        : []),
      // Properties item inserted in Task 9
      { label: '', separator: true },
      {
        label: t('fb.selectAll'),
        disabled: visible.length === 0,
        onClick: () => setSelected(new Set(visible.map((v) => v.name))),
      },
      { label: t('fb.refresh'), onClick: () => load(path) },
    ];
  };
```

- [ ] **Step 5: i18n keys:**

```ts
  'fb.edit': { vi: 'Chỉnh sửa', en: 'Edit' },
  'fb.editWith': { vi: 'Sửa bằng…', en: 'Edit with…' },
  'fb.editBrowse': { vi: 'Chọn ứng dụng…', en: 'Browse…' },
  'fb.newFile': { vi: 'Tạo file mới', en: 'New file' },
  'fb.promptNewFile': { vi: 'Tên file mới', en: 'New file name' },
  'fb.errNewFile': { vi: 'Tạo file lỗi: {err}', en: 'Create file failed: {err}' },
  'fb.copyPath': { vi: 'Chép đường dẫn', en: 'Copy path' },
  'fb.errEdit': { vi: 'Mở chỉnh sửa lỗi: {err}', en: 'Edit failed: {err}' },
```

- [ ] **Step 6: Wire in FileBrowser** — backends gain `touch` (imports: `fsTouch`, `sftpTouch` from `../ipc/ssh`; `startEdit` from `../state/edits`; `editOpen` from `../ipc/edit`):

```ts
  const localBackend = useMemo<FsBackend>(
    () => ({ list: fsList, mkdir: fsMkdir, rename: fsRename, remove: fsRemove, home: fsHome, touch: fsTouch, sep: LOCAL_SEP }),
    []
  );
  // remoteBackend adds:  touch: (p) => sftpTouch(pane.id, p),
```

Handlers (memoized once, under the backends):

```ts
  // Edit: local = open the file itself; remote = temp-download + watch + auto-upload.
  const editLocal = useMemo(
    () => (e: FileEntry, dir: string, app?: string) =>
      void startEdit({ paneId: pane.id, remote: false, dir, name: e.name, sep: LOCAL_SEP, app }).catch(
        (err) => alert(t('fb.errEdit', { err: String(err) }))
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pane.id]
  );
  const editRemote = useMemo(
    () => (e: FileEntry, dir: string, app?: string) =>
      void startEdit({ paneId: pane.id, remote: true, dir, name: e.name, sep: '/', app }).catch(
        (err) => alert(t('fb.errEdit', { err: String(err) }))
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pane.id]
  );
  // Open: local = OS default app; remote "Open" = the edit flow (Bitvise behavior).
  const openLocal = useMemo(
    () => (e: FileEntry, dir: string) =>
      void editOpen(joinPath(dir, e.name, LOCAL_SEP)).catch((err) => alert(t('fb.errEdit', { err: String(err) }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const openRemote = useMemo(() => (e: FileEntry, dir: string) => editRemote(e, dir, undefined), [editRemote]);
```

Pass to the three `<FilePanel>` instances: local panel(s) get `onEditFile={editLocal} onOpenFile={openLocal}`; the remote panel gets `onEditFile={editRemote} onOpenFile={openRemote}`. (`joinPath` import already exists in FilePanel; add it to FileBrowser imports from `./pathUtils`.)

- [ ] **Step 7: Verify** — `npx tsc --noEmit`; then `npm run tauri dev`: double-click a local file opens it; right-click → Edit opens the default editor; on a remote file Edit downloads + opens, saving in the editor uploads (watch the chip + server content); New file & Copy path work on both panes.

- [ ] **Step 8: Commit** — `git add src/components/FilePanel.tsx src/components/FileBrowser.tsx src/i18n.ts && git commit -m "feat(fb): Edit / Edit with / Open / Copy path / New file"`

---

### Task 8: Cut / Copy / Paste (+ local↔local copy revival)

**Files:**
- Modify: `src/components/FileBrowser.tsx` (clipboard state, paste matrix, runBatch returns summary, local-only transfer buttons)
- Modify: `src/components/FilePanel.tsx` (menu items, Ctrl+X/C/V, cut dimming)
- Modify: `src/i18n.ts`

**Interfaces:**
- Consumes: `fsCopy`, `sftpCopy` (Tasks 1-2), `runTransfer`/`TransferOps` (transfer.ts), existing `uploadOps`/`downloadOps`.
- Produces (FilePanel props): `onCut/onCopy: (entries: FileEntry[], dir: string) => void`, `onPaste: (dir: string) => void`, `canPaste: boolean`, `cutMarks: { dir: string; names: string[] } | null`.

- [ ] **Step 1: `runBatch` returns the summary** — change its signature/body in FileBrowser to `): Promise<TransferSummary | null> => {` and `const result = await runTransfer(...); setSummary({ ...result, verb }); return result;` (return `null` from the catch branch). Existing callers ignore the return value — no other change.

- [ ] **Step 2: clipboard state + paste in FileBrowser:**

```ts
type ClipSide = 'left' | 'right';
interface Clip {
  op: 'copy' | 'cut';
  side: ClipSide;
  base: string;
  sep: string;
  entries: FileEntry[];
}
// inside FileBrowser():
const [clip, setClip] = useState<Clip | null>(null);

const localCopyOps: TransferOps = {
  srcList: fsList,
  srcSep: LOCAL_SEP,
  dstList: fsList,
  dstSep: LOCAL_SEP,
  dstMkdir: fsMkdir,
  doTransfer: (s, d) => fsCopy(s, d),
};
const remoteCopyOps: TransferOps = {
  srcList: (d) => sftpList(pane.id, d),
  srcSep: '/',
  dstList: (d) => sftpList(pane.id, d),
  dstSep: '/',
  dstMkdir: (d) => sftpMkdir(pane.id, d),
  doTransfer: (s, d) => sftpCopy(pane.id, s, d),
};

/** 'remote' only when this browser HAS a remote and it's the right side. */
const kindOf = (side: ClipSide): 'local' | 'remote' =>
  side === 'right' && hasRemote ? 'remote' : 'local';

const doPaste = async (dstSide: ClipSide, dstDir: string) => {
  if (!clip || busy) return;
  const srcKind = kindOf(clip.side);
  const dstKind = kindOf(dstSide);
  const sameKind = srcKind === dstKind;
  const dstSep = dstKind === 'local' ? LOCAL_SEP : '/';

  // Cut into the source dir itself = no-op; a folder into its own subtree = error.
  if (clip.op === 'cut' && clip.side === dstSide && clip.base === dstDir) {
    setClip(null);
    return;
  }
  if (sameKind) {
    for (const en of clip.entries) {
      if (!en.isDir) continue;
      const src = joinPath(clip.base, en.name, clip.sep);
      if (dstDir === src || dstDir.startsWith(src + clip.sep)) {
        alert(t('fb.errPasteSub'));
        return;
      }
    }
  }

  const ops: TransferOps = sameKind
    ? srcKind === 'local'
      ? localCopyOps
      : remoteCopyOps
    : srcKind === 'local'
      ? uploadOps
      : downloadOps;
  const srcBackend = srcKind === 'local' ? localBackend : remoteBackend;

  if (clip.op === 'cut' && sameKind) {
    // Fast path: same-backend move = rename. Fall back to copy+delete per entry
    // (name conflict at the target, or EXDEV across drives).
    const viaCopy: FileEntry[] = [];
    const dstNames = new Set(
      (await ops.dstList(dstDir).catch(() => [] as FileEntry[])).map((x) => x.name)
    );
    for (const en of clip.entries) {
      if (dstNames.has(en.name)) {
        viaCopy.push(en);
        continue;
      }
      try {
        await srcBackend.rename(joinPath(clip.base, en.name, clip.sep), joinPath(dstDir, en.name, dstSep));
      } catch {
        viaCopy.push(en);
      }
    }
    if (viaCopy.length) {
      const res = await runBatch(viaCopy, clip.base, dstDir, ops, t('fb.verbMove'));
      // Delete sources ONLY on a fully clean batch (no fail/skip/cancel) — never lose data.
      if (res && !res.cancelled && res.failed === 0 && res.skipped === 0) {
        for (const en of viaCopy) {
          try {
            await srcBackend.remove(joinPath(clip.base, en.name, clip.sep), en.isDir);
          } catch {
            /* leave the source in place */
          }
        }
      }
    }
    setLeftKey((k) => k + 1);
    setRightKey((k) => k + 1);
  } else {
    const verb = clip.op === 'cut' ? t('fb.verbMove') : t('fb.verbCopy');
    const res = await runBatch(clip.entries, clip.base, dstDir, ops, verb);
    if (clip.op === 'cut' && res && !res.cancelled && res.failed === 0 && res.skipped === 0) {
      for (const en of clip.entries) {
        try {
          await srcBackend.remove(joinPath(clip.base, en.name, clip.sep), en.isDir);
        } catch {
          /* leave the source in place */
        }
      }
      setLeftKey((k) => k + 1);
      setRightKey((k) => k + 1);
    }
  }
  setClip(null);
};
```

- [ ] **Step 3: pass clipboard props to the panels** — for each `<FilePanel>` (side = `'left'` for the local panel, `'right'` for remote/local2):

```tsx
  onCut={(entries, dir) => setClip({ op: 'cut', side: 'left', base: dir, sep: LOCAL_SEP, entries })}
  onCopy={(entries, dir) => setClip({ op: 'copy', side: 'left', base: dir, sep: LOCAL_SEP, entries })}
  onPaste={(dir) => void doPaste('left', dir)}
  canPaste={!!clip && !busy}
  cutMarks={clip?.op === 'cut' && clip.side === 'left' ? { dir: clip.base, names: clip.entries.map((e) => e.name) } : null}
```

(right side: `side: 'right'`, `sep: hasRemote ? '/' : LOCAL_SEP`.)

- [ ] **Step 4: local↔local transfer buttons** — replace the two dead `alert(...)` handlers (FileBrowser ~lines 475 and 537):

```tsx
  // left panel:
  onTransfer={(entries, from) =>
    hasRemote
      ? onUpload(entries, from)
      : void runBatch(entries, from, remoteCwd.current, localCopyOps, t('fb.verbCopy'))
  }
  // right local2 panel:
  onTransfer={(entries, from) =>
    void runBatch(entries, from, localCwd.current, localCopyOps, t('fb.verbCopy'))
  }
```

- [ ] **Step 5: FilePanel side** — new props:

```ts
  onCut?: (entries: FileEntry[], dir: string) => void;
  onCopy?: (entries: FileEntry[], dir: string) => void;
  onPaste?: (dir: string) => void;
  canPaste?: boolean;
  /** Entries rendered dimmed (they're on the clipboard as a cut). */
  cutMarks?: { dir: string; names: string[] } | null;
```

Menu items (replace the `// clipboard items inserted in Task 8` marker):

```ts
      { label: t('fb.cut'), disabled: list.length === 0 || !onCut, onClick: () => onCut?.(list, path) },
      { label: t('fb.copy'), disabled: list.length === 0 || !onCopy, onClick: () => onCopy?.(list, path) },
      { label: t('fb.paste'), disabled: !canPaste || !onPaste, onClick: () => onPaste?.(path) },
```

Keyboard — in `onListKeyDown`, after the Ctrl+A block:

```ts
    if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X')) {
      e.preventDefault();
      const sel = selectedEntries();
      if (sel.length) onCut?.(sel, path);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      const sel = selectedEntries();
      if (sel.length) onCopy?.(sel, path);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      if (canPaste) onPaste?.(path);
      return;
    }
```

Cut dimming — on the row div (`className` line ~654):

```tsx
  const isCutDim = (name: string) =>
    !!cutMarks && cutMarks.dir === path && cutMarks.names.includes(name);
  // row:
  style={isCutDim(e.name) ? { opacity: 0.45 } : undefined}
```

- [ ] **Step 6: i18n keys:**

```ts
  'fb.cut': { vi: 'Cắt', en: 'Cut' },
  'fb.copy': { vi: 'Sao chép', en: 'Copy' },
  'fb.paste': { vi: 'Dán', en: 'Paste' },
  'fb.verbCopy': { vi: 'Chép', en: 'Copied' },
  'fb.verbMove': { vi: 'Chuyển', en: 'Moved' },
  'fb.errPasteSub': {
    vi: 'Không thể dán thư mục vào bên trong chính nó',
    en: 'Cannot paste a folder into itself',
  },
```

- [ ] **Step 7: Verify** — `npx tsc --noEmit`; `npm run tauri dev`: copy/cut/paste within local, within remote, local→remote, remote→local (6 directions with cut+copy), Ctrl+X/C/V, cut rows dim, paste-into-own-subtree blocked, cut into same dir is a no-op, conflict dialog appears on collision, and the two-local-pane copy buttons now work.

- [ ] **Step 8: Commit** — `git add src/components/FileBrowser.tsx src/components/FilePanel.tsx src/i18n.ts && git commit -m "feat(fb): cut/copy/paste + move, local-local copy"`

---

### Task 9: Properties dialog

**Files:**
- Create: `src/components/PropertiesDialog.tsx`
- Modify: `src/components/FilePanel.tsx` (FsBackend `stat?`/`dirSize?`, menu item, render)
- Modify: `src/components/FileBrowser.tsx` (backends gain stat/dirSize)
- Modify: `src/i18n.ts`

**Interfaces:**
- Consumes: `fsStat/sftpStat/fsDirSize/sftpDirSize` + `StatInfo` (Tasks 1-2), overlay-dialog pattern (PromptDialog), `backend.chmod` for the rwx grid.
- Produces: `<PropertiesDialog entry dir backend onClose onChanged />`; `FsBackend.stat?: (path) => Promise<StatInfo>`, `FsBackend.dirSize?: (path) => Promise<number>`.

- [ ] **Step 1: FsBackend** — add optional members in FilePanel.tsx:

```ts
  /** Full metadata for the Properties dialog. */
  stat?: (path: string) => Promise<StatInfo>;
  /** Recursive size of a directory (bounded). */
  dirSize?: (path: string) => Promise<number>;
```

(import `StatInfo` type from `../ipc/ssh`). In FileBrowser: `localBackend` gains `stat: fsStat, dirSize: fsDirSize`; `remoteBackend` gains `stat: (p) => sftpStat(pane.id, p), dirSize: (p) => sftpDirSize(pane.id, p)`.

- [ ] **Step 2: Create `src/components/PropertiesDialog.tsx`:**

```tsx
// Bitvise-style Properties dialog: metadata + (remote) an editable rwx grid.
import { useEffect, useState } from 'react';
import type { FileEntry, StatInfo } from '../ipc/ssh';
import type { FsBackend } from './FilePanel';
import { joinPath } from './pathUtils';
import { useT } from '../i18n';

function fmtBytesLong(b: number): string {
  const u = b >= 1073741824 ? [1073741824, 'GB'] : b >= 1048576 ? [1048576, 'MB'] : b >= 1024 ? [1024, 'KB'] : null;
  return u ? `${(b / (u[0] as number)).toFixed(1)} ${u[1]} (${b.toLocaleString()} B)` : `${b} B`;
}
function fmtTime(unixSec: number): string {
  if (!unixSec) return '—';
  return new Date(unixSec * 1000).toLocaleString();
}

export function PropertiesDialog({
  entry,
  dir,
  backend,
  onClose,
  onChanged,
}: {
  entry: FileEntry;
  dir: string;
  backend: FsBackend;
  onClose: () => void;
  /** Called after a chmod was applied so the panel can reload. */
  onChanged?: () => void;
}) {
  const t = useT();
  const full = joinPath(dir, entry.name, backend.sep);
  const [st, setSt] = useState<StatInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dirSize, setDirSize] = useState<number | null>(null);
  const [calcing, setCalcing] = useState(false);
  const [mode, setMode] = useState<number>(entry.mode & 0o777);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let alive = true;
    backend
      .stat?.(full)
      .then((s) => {
        if (!alive) return;
        setSt(s);
        setMode(s.mode & 0o777);
      })
      .catch((e) => alive && setErr(String(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full]);

  const calc = async () => {
    if (!backend.dirSize) return;
    setCalcing(true);
    try {
      setDirSize(await backend.dirSize(full));
    } catch {
      setDirSize(null);
    } finally {
      setCalcing(false);
    }
  };

  const applyMode = async () => {
    if (!backend.chmod) return;
    setApplying(true);
    try {
      await backend.chmod(full, mode);
      onChanged?.();
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setApplying(false);
    }
  };

  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div style={{ display: 'flex', gap: 10, padding: '3px 0' }}>
      <span style={{ width: 110, flex: 'none', font: '400 11px var(--font-ui)', color: 'var(--text-muted)' }}>{k}</span>
      <span className="mono" style={{ font: '400 11px var(--font-mono)', color: 'var(--text)', wordBreak: 'break-all' }}>{v}</span>
    </div>
  );

  const bit = (shift: number, m: number) => (mode >> shift) & m;
  const toggle = (shift: number, m: number) => setMode((v) => v ^ (m << shift));

  return (
    <div
      onMouseDown={onClose}
      style={{ position: 'absolute', inset: 0, background: 'rgba(5,7,10,0.55)', display: 'grid', placeItems: 'center', zIndex: 46 }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{ width: 400, maxHeight: '90%', overflow: 'auto', background: 'var(--surface-2)', border: '1px solid var(--border-3)', borderRadius: 12, boxShadow: '0 24px 60px rgba(0,0,0,0.6)', padding: 20 }}
      >
        <div style={{ font: '600 13px var(--font-ui)', color: 'var(--text)', marginBottom: 12 }}>
          {t('prop.title')} — {entry.name}
        </div>
        {err && <div style={{ color: 'var(--danger)', font: '400 11px var(--font-mono)', marginBottom: 8 }}>{err}</div>}

        <Row k={t('prop.path')} v={full} />
        <Row k={t('prop.type')} v={entry.isDir ? t('prop.typeDir') : t('prop.typeFile')} />
        <Row
          k={t('prop.size')}
          v={
            entry.isDir ? (
              dirSize !== null ? (
                fmtBytesLong(dirSize)
              ) : (
                <button className="ghost-btn" style={{ fontSize: 10.5 }} disabled={calcing || !backend.dirSize} onClick={() => void calc()}>
                  {calcing ? '…' : t('prop.calc')}
                </button>
              )
            ) : (
              fmtBytesLong(st?.size ?? entry.size)
            )
          }
        />
        <Row k={t('prop.modified')} v={fmtTime(st?.modified ?? entry.modified)} />
        {st && st.created > 0 && <Row k={t('prop.created')} v={fmtTime(st.created)} />}
        {st && st.accessed > 0 && <Row k={t('prop.accessed')} v={fmtTime(st.accessed)} />}
        {st?.isSymlink && <Row k={t('prop.symlink')} v={st.linkTarget || '—'} />}
        {/* local-only attributes */}
        {st && !backend.chmod && (
          <Row k={t('prop.attrs')} v={[st.readonly && t('prop.readonly'), st.hidden && t('prop.hidden')].filter(Boolean).join(', ') || '—'} />
        )}
        {/* remote-only: owner + editable permission grid */}
        {backend.chmod && st && (
          <>
            <Row k={t('prop.owner')} v={`uid ${st.uid} · gid ${st.gid}`} />
            <div style={{ marginTop: 12, borderTop: '1px solid var(--border-2)', paddingTop: 10 }}>
              <div style={{ font: '600 11.5px var(--font-ui)', color: 'var(--text)', marginBottom: 6 }}>
                {t('prop.perms')} — {(mode & 0o777).toString(8).padStart(3, '0')}
              </div>
              <table style={{ borderCollapse: 'collapse', font: '400 11px var(--font-ui)', color: 'var(--text-2)' }}>
                <thead>
                  <tr>
                    <th />
                    {['r', 'w', 'x'].map((h) => (
                      <th key={h} style={{ padding: '2px 10px', color: 'var(--text-muted)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: t('prop.permOwner'), shift: 6 },
                    { label: t('prop.permGroup'), shift: 3 },
                    { label: t('prop.permOther'), shift: 0 },
                  ].map((row) => (
                    <tr key={row.shift}>
                      <td style={{ padding: '2px 10px 2px 0' }}>{row.label}</td>
                      {[4, 2, 1].map((m) => (
                        <td key={m} style={{ textAlign: 'center' }}>
                          <input type="checkbox" checked={!!bit(row.shift, m)} onChange={() => toggle(row.shift, m)} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="ghost-btn" style={{ flex: 1, height: 36, justifyContent: 'center' }} onClick={onClose}>
            {t('common.cancel')}
          </button>
          {backend.chmod && (
            <button className="accent-btn" style={{ flex: 1, height: 36, justifyContent: 'center' }} disabled={applying} onClick={() => void applyMode()}>
              {t('prop.apply')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: FilePanel integration** — `import { PropertiesDialog } from './PropertiesDialog';`; state `const [propsFor, setPropsFor] = useState<FileEntry | null>(null);`; menu item (replace the `// Properties item inserted in Task 9` marker):

```ts
      { label: t('fb.properties'), disabled: !target, onClick: () => target && (setMenu(null), setPropsFor(target)) },
```

Render next to the other dialogs:

```tsx
      {propsFor && (
        <PropertiesDialog
          entry={propsFor}
          dir={path}
          backend={backend}
          onClose={() => setPropsFor(null)}
          onChanged={() => void load(path)}
        />
      )}
```

- [ ] **Step 4: i18n keys:**

```ts
  'fb.properties': { vi: 'Thuộc tính', en: 'Properties' },
  'prop.title': { vi: 'Thuộc tính', en: 'Properties' },
  'prop.path': { vi: 'Đường dẫn', en: 'Path' },
  'prop.type': { vi: 'Loại', en: 'Type' },
  'prop.typeFile': { vi: 'File', en: 'File' },
  'prop.typeDir': { vi: 'Thư mục', en: 'Folder' },
  'prop.size': { vi: 'Dung lượng', en: 'Size' },
  'prop.calc': { vi: 'Tính dung lượng', en: 'Calculate' },
  'prop.modified': { vi: 'Sửa lúc', en: 'Modified' },
  'prop.created': { vi: 'Tạo lúc', en: 'Created' },
  'prop.accessed': { vi: 'Truy cập lúc', en: 'Accessed' },
  'prop.symlink': { vi: 'Liên kết tới', en: 'Symlink target' },
  'prop.attrs': { vi: 'Thuộc tính', en: 'Attributes' },
  'prop.readonly': { vi: 'Chỉ đọc', en: 'Read-only' },
  'prop.hidden': { vi: 'Ẩn', en: 'Hidden' },
  'prop.owner': { vi: 'Chủ sở hữu', en: 'Owner' },
  'prop.perms': { vi: 'Quyền', en: 'Permissions' },
  'prop.permOwner': { vi: 'Chủ', en: 'Owner' },
  'prop.permGroup': { vi: 'Nhóm', en: 'Group' },
  'prop.permOther': { vi: 'Khác', en: 'Others' },
  'prop.apply': { vi: 'Áp dụng', en: 'Apply' },
```

- [ ] **Step 5: Verify** — `npx tsc --noEmit`; dev run: Properties on local file/dir (attrs shown, dir Calculate works) and remote file/dir (uid/gid + rwx grid; toggling boxes updates the octal preview; Apply changes perms on the server and the listing reloads).

- [ ] **Step 6: Commit** — `git add src/components/PropertiesDialog.tsx src/components/FilePanel.tsx src/components/FileBrowser.tsx src/i18n.ts && git commit -m "feat(fb): Properties dialog with rwx grid + dir size"`

---

### Task 10: Full verification sweep

**Files:** none (verification only; fix regressions where found)

- [ ] **Step 1:** `npx tsc --noEmit` → 0 errors.
- [ ] **Step 2:** `cargo test --manifest-path src-tauri/Cargo.toml` → all pass; `cargo check --manifest-path src-tauri/Cargo.toml` → clean (no new warnings).
- [ ] **Step 3: Manual pass** (`npm run tauri dev`, needs one SSH host):
  - Edit remote file with Notepad++ (set as default editor) → save → file content on server updates; chip shows "✎ 1", popover shows the upload time.
  - Edit with… → Browse → pick another exe → it's remembered in Settings and the submenu.
  - Kill network → save → chip turns red with the error → restore network → save again (or Re-upload) succeeds.
  - Double-click: local file opens with the OS app; remote file enters the edit flow.
  - Cut/copy/paste in all directions incl. two-local-pane mode; cut rows dim; guards work.
  - New file / Copy path / Properties / chmod grid on both sides.
  - Regression: plain upload/download, sync, rename, delete, search still behave.
- [ ] **Step 4:** Update the spec's Status line to `implemented`, commit any fixes: `git commit -am "chore: post-verification fixes for SFTP edit/clipboard/properties"`.
