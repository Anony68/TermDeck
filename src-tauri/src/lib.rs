mod pty;
mod shells;

use pty::{PtyEvent, PtyManager};
use tauri::ipc::Channel;
use tauri::State;

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
        .manage(PtyManager::new())
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
