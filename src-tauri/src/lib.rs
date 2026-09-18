mod edit;
mod ssh;

use ssh::SshManager;

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
        .manage(SshManager::new())
        .manage(edit::EditManager::new())
        .setup(|_app| {
            edit::sweep_stale();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_text,
            read_text,
            download_and_run,
            ssh::spawn_ssh,
            ssh::write_ssh,
            ssh::resize_ssh,
            ssh::kill_ssh,
            ssh::secret_set,
            ssh::secret_copy,
            ssh::secret_delete,
            ssh::parse_tlp,
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
            ssh::sftp_stat,
            ssh::sftp_touch,
            ssh::sftp_copy,
            ssh::sftp_dir_size,
            ssh::sftp_dir_size_cancel,
            ssh::fs_list,
            ssh::fs_mkdir,
            ssh::fs_rename,
            ssh::fs_remove,
            ssh::fs_home,
            ssh::fs_stat,
            ssh::fs_touch,
            ssh::fs_copy,
            ssh::fs_dir_size,
            ssh::ssh_config_hosts,
            edit::edit_prepare,
            edit::edit_open,
            edit::edit_watch,
            edit::edit_unwatch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
