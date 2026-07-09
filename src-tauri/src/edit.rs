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
