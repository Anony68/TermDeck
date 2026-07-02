mod pty;
mod shells;

use pty::{PtyEvent, PtyManager};
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
                    let mut stack = vec![Pid::from_u32(*pid)];
                    while let Some(p) = stack.pop() {
                        if let Some(proc_) = sys.process(p) {
                            cpu += proc_.cpu_usage();
                            mem += proc_.memory();
                        }
                        if let Some(ch) = children.get(&p) {
                            stack.extend(ch.iter().copied());
                        }
                    }
                    PaneStat { pane_id: pane.clone(), cpu, mem }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(PtyManager::new())
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
            kill_pty
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
