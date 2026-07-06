//! PTY lifecycle management. The Rust side owns every pseudo-terminal (via
//! portable-pty / ConPTY on Windows); output streams to the frontend over a
//! Tauri `Channel`, keystrokes and resizes come back in as commands.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;

use crate::shells;

/// One event pushed to a pane's Channel. Serialized as
/// `{ "type": "data", "data": [..] }` or `{ "type": "exit", "code": 0 }`.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PtyEvent {
    Data {
        data: Vec<u8>,
    },
    Exit {
        code: i32,
        /// Human-readable reason when the process failed to start or ended
        /// abnormally, so the UI can show *why* instead of a bare exit code.
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// Managed Tauri state. `sessions` is an `Arc` so reader/waiter threads can hold
/// a clone and clean up when a process exits. `pids` maps pane -> child PID for
/// the stats sampler.
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
    pids: Arc<Mutex<HashMap<String, u32>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            pids: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Clone of the pane -> PID map for the background stats thread.
    pub fn pids(&self) -> Arc<Mutex<HashMap<String, u32>>> {
        self.pids.clone()
    }

    pub fn spawn(
        &self,
        pane_id: String,
        shell: String,
        cwd: String,
        cols: u16,
        rows: u16,
        command: Option<String>,
        shell_path: Option<String>,
        on_event: Channel<PtyEvent>,
    ) -> Result<(), String> {
        // Replace any existing session for this pane (e.g. restart).
        self.kill(pane_id.clone()).ok();

        let spec = shells::build_command(&shell, shell_path.as_deref(), &cwd)?;

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let mut cmd = CommandBuilder::new(&spec.exe);
        for a in &spec.args {
            cmd.arg(a);
        }
        for (k, v) in &spec.envs {
            cmd.env(k, v);
        }
        // Start in the requested directory when it exists, otherwise fall back
        // to the user's home dir — a stale/removed path must never leave the
        // shell in a bad cwd (or, on some platforms, abort the spawn).
        if spec.set_cwd {
            if let Some(dir) = effective_cwd(&cwd) {
                cmd.cwd(dir);
            }
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| e.to_string())?;
        // Dropping the slave avoids a hang on some platforms once the child owns it.
        drop(pair.slave);

        let killer = child.clone_killer();
        let child_pid = child.process_id();
        let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

        if let Some(pid) = child_pid {
            self.pids.lock().unwrap().insert(pane_id.clone(), pid);
        }

        // Optional auto-run command (only sent when the caller opts in).
        if let Some(c) = command {
            if !c.trim().is_empty() {
                let _ = writer.write_all(format!("{c}\r").as_bytes());
                let _ = writer.flush();
            }
        }

        self.sessions.lock().unwrap().insert(
            pane_id.clone(),
            PtySession {
                writer,
                master: pair.master,
                killer,
            },
        );

        // Reader thread: stream PTY output to the frontend until EOF.
        let data_ch = on_event.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if data_ch
                            .send(PtyEvent::Data {
                                data: buf[..n].to_vec(),
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Waiter thread: report the exit code and drop the session.
        let exit_ch = on_event;
        let sessions = self.sessions.clone();
        let pids = self.pids.clone();
        std::thread::spawn(move || {
            let (code, error) = match child.wait() {
                Ok(s) => (s.exit_code() as i32, None),
                Err(e) => (-1, Some(format!("tiến trình lỗi: {e}"))),
            };
            let _ = exit_ch.send(PtyEvent::Exit { code, error });
            sessions.lock().unwrap().remove(&pane_id);
            pids.lock().unwrap().remove(&pane_id);
        });

        Ok(())
    }

    pub fn write(&self, pane_id: String, data: String) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(&pane_id)
            .ok_or_else(|| "pane không tồn tại".to_string())?;
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        session.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, pane_id: String, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get(&pane_id) {
            session
                .master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn kill(&self, pane_id: String) -> Result<(), String> {
        if let Some(mut session) = self.sessions.lock().unwrap().remove(&pane_id) {
            let _ = session.killer.kill();
        }
        self.pids.lock().unwrap().remove(&pane_id);
        Ok(())
    }
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}

/// The directory the shell should start in: the requested `cwd` when it's an
/// existing directory, otherwise the user's home directory. Returns `None` only
/// if neither exists, in which case the child inherits the process cwd.
fn effective_cwd(requested: &str) -> Option<std::path::PathBuf> {
    let p = std::path::Path::new(requested);
    if !requested.is_empty() && p.is_dir() {
        return Some(p.to_path_buf());
    }
    home_dir().filter(|h| h.is_dir())
}

/// The current user's home directory (`$HOME` on Unix, `%USERPROFILE%` on Windows).
fn home_dir() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    let var = std::env::var_os("USERPROFILE");
    #[cfg(unix)]
    let var = std::env::var_os("HOME");
    var.filter(|v| !v.is_empty()).map(std::path::PathBuf::from)
}
