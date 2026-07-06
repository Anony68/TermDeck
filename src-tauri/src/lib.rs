mod claude;
mod pty;
mod shells;
mod ssh;

use pty::{PtyEvent, PtyManager};
use ssh::SshManager;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PaneStat {
    pane_id: String,
    cpu: f32,
    mem: u64,
    /// True when a Claude Code process is running inside this pane's subtree.
    claude: bool,
}

/// Heuristic: the native installer runs as `claude.exe`; npm installs run it as
/// `node …\@anthropic-ai\claude-code\cli.js` (via a `claude.cmd`/`claude.ps1` shim).
fn is_claude_process(p: &sysinfo::Process) -> bool {
    let name = p.name().to_string_lossy().to_lowercase();
    if name.contains("claude") {
        return true;
    }
    if name.starts_with("node") || name.starts_with("bun") {
        return p
            .cmd()
            .iter()
            .any(|a| a.to_string_lossy().to_lowercase().contains("claude"));
    }
    false
}

/// Background thread that samples CPU% + memory (summed over each cmd's process
/// subtree) every ~1.5s and emits them to the frontend as `pane://stats`.
fn start_stats(handle: AppHandle, pids: Arc<Mutex<HashMap<String, u32>>>) {
    std::thread::spawn(move || {
        use sysinfo::{Pid, ProcessesToUpdate, System};
        let mut sys = System::new();
        loop {
            std::thread::sleep(Duration::from_millis(1500));
            let map = pids.lock().unwrap().clone();
            if map.is_empty() {
                continue;
            }
            sys.refresh_processes(ProcessesToUpdate::All, true);

            // Map parent -> children so we can sum a whole subtree.
            let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
            for (pid, proc_) in sys.processes() {
                if let Some(parent) = proc_.parent() {
                    children.entry(parent).or_default().push(*pid);
                }
            }

            let stats: Vec<PaneStat> = map
                .iter()
                .map(|(pane, pid)| {
                    let mut cpu = 0.0f32;
                    let mut mem = 0u64;
                    let mut claude = false;
                    let mut stack = vec![Pid::from_u32(*pid)];
                    while let Some(p) = stack.pop() {
                        if let Some(proc_) = sys.process(p) {
                            cpu += proc_.cpu_usage();
                            mem += proc_.memory();
                            if !claude && is_claude_process(proc_) {
                                claude = true;
                            }
                        }
                        if let Some(ch) = children.get(&p) {
                            stack.extend(ch.iter().copied());
                        }
                    }
                    PaneStat { pane_id: pane.clone(), cpu, mem, claude }
                })
                .collect();

            let _ = handle.emit("pane://stats", stats);
        }
    });
}

#[tauri::command]
fn detect_shells() -> Vec<shells::ShellInfo> {
    shells::detect_all()
}

#[tauri::command(rename_all = "camelCase")]
fn spawn_pty(
    state: State<PtyManager>,
    pane_id: String,
    shell: String,
    cwd: String,
    cols: u16,
    rows: u16,
    command: Option<String>,
    shell_path: Option<String>,
    on_event: Channel<PtyEvent>,
) -> Result<(), String> {
    state.spawn(pane_id, shell, cwd, cols, rows, command, shell_path, on_event)
}

#[tauri::command(rename_all = "camelCase")]
fn write_pty(state: State<PtyManager>, pane_id: String, data: String) -> Result<(), String> {
    state.write(pane_id, data)
}

#[tauri::command(rename_all = "camelCase")]
fn resize_pty(
    state: State<PtyManager>,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(pane_id, cols, rows)
}

#[tauri::command(rename_all = "camelCase")]
fn kill_pty(state: State<PtyManager>, pane_id: String) -> Result<(), String> {
    state.kill(pane_id)
}

#[tauri::command]
fn save_text(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Download an installer (following redirects) to the temp dir and launch it.
#[tauri::command]
fn download_and_run(url: String) -> Result<String, String> {
    let tmp = std::env::temp_dir().join("TermDeck-update-setup.exe");
    let resp = ureq::get(&url)
        .header("User-Agent", "TermDeck-Updater")
        .call()
        .map_err(|e| e.to_string())?;
    let mut reader = resp.into_body().into_reader();
    let mut out = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    std::io::copy(&mut reader, &mut out).map_err(|e| e.to_string())?;
    drop(out);
    std::process::Command::new(&tmp)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(tmp.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(PtyManager::new())
        .manage(SshManager::new())
        .setup(|app| {
            let pids = app.state::<PtyManager>().pids();
            start_stats(app.handle().clone(), pids);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect_shells,
            spawn_pty,
            write_pty,
            resize_pty,
            kill_pty,
            save_text,
            read_text,
            download_and_run,
            claude::claude_session,
            claude::claude_sessions,
            ssh::spawn_ssh,
            ssh::write_ssh,
            ssh::resize_ssh,
            ssh::kill_ssh,
            ssh::secret_set,
            ssh::secret_delete,
            ssh::sftp_connect,
            ssh::sftp_disconnect,
            ssh::sftp_home,
            ssh::sftp_list,
            ssh::sftp_mkdir,
            ssh::sftp_rename,
            ssh::sftp_remove,
            ssh::sftp_chmod,
            ssh::sftp_search,
            ssh::sftp_upload,
            ssh::sftp_download,
            ssh::fs_list,
            ssh::fs_mkdir,
            ssh::fs_rename,
            ssh::fs_remove,
            ssh::fs_home,
            ssh::ssh_config_hosts
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
