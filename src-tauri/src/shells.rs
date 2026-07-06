//! Detect and build launch specs for the shells TermDeck supports.
//!
//! On Windows: PowerShell, CMD, Git Bash, and WSL.
//!
//! On macOS/Linux none of CMD/Git Bash/WSL exist (Git Bash ships only as part
//! of "Git for Windows"), so the `git-bash` slot is repurposed as the native
//! default terminal — the user's login shell (`$SHELL`, else zsh/bash) — and
//! `powershell` maps to `pwsh` when installed. CMD and WSL report unavailable.

use serde::Serialize;
use std::path::Path;

/// Information about one shell, returned to the frontend so it can show/hide
/// options in the "Add cmd" dialog.
#[derive(Debug, Clone, Serialize)]
pub struct ShellInfo {
    pub kind: String,
    pub label: String,
    pub path: String,
    pub available: bool,
}

/// A fully resolved command to hand to portable-pty.
pub struct SpawnSpec {
    pub exe: String,
    pub args: Vec<String>,
    pub envs: Vec<(String, String)>,
    /// Whether to set the child's working directory from `cwd` (WSL handles cwd
    /// via the `--cd` argument instead).
    pub set_cwd: bool,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// Search PATH for an executable (Windows: appends nothing, expects full name).
fn which(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

fn first_existing(candidates: &[Option<String>]) -> Option<String> {
    candidates
        .iter()
        .flatten()
        .find(|p| Path::new(p).is_file())
        .cloned()
}

/// Resolve the executable path for a shell kind, honoring an optional override.
pub fn resolve(kind: &str, path_override: Option<&str>) -> Option<String> {
    if let Some(p) = path_override {
        if !p.is_empty() && Path::new(p).is_file() {
            return Some(p.to_string());
        }
    }
    resolve_native(kind)
}

#[cfg(windows)]
fn resolve_native(kind: &str) -> Option<String> {
    let sysroot = env("SystemRoot").unwrap_or_else(|| "C:\\Windows".to_string());
    match kind {
        "cmd" => first_existing(&[
            env("ComSpec"),
            Some(format!("{sysroot}\\System32\\cmd.exe")),
        ]),
        "powershell" => first_existing(&[
            which("pwsh.exe"),
            Some(format!(
                "{sysroot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
            )),
        ]),
        // NOTE: do NOT use `which("bash.exe")` — on Windows that resolves to
        // System32\bash.exe which is the WSL launcher, not Git Bash.
        "git-bash" => first_existing(&[
            env("ProgramFiles").map(|p| format!("{p}\\Git\\bin\\bash.exe")),
            env("ProgramFiles").map(|p| format!("{p}\\Git\\usr\\bin\\bash.exe")),
            env("ProgramFiles(x86)").map(|p| format!("{p}\\Git\\bin\\bash.exe")),
            env("LOCALAPPDATA").map(|p| format!("{p}\\Programs\\Git\\bin\\bash.exe")),
        ]),
        "wsl" => first_existing(&[Some(format!("{sysroot}\\System32\\wsl.exe"))]),
        _ => None,
    }
}

#[cfg(unix)]
fn resolve_native(kind: &str) -> Option<String> {
    match kind {
        // Git Bash is Windows-only; on macOS/Linux this slot launches the
        // native default terminal (the user's login shell).
        "git-bash" => native_default_shell(),
        // PowerShell Core (`pwsh`) is installable via Homebrew; detect it.
        "powershell" => which("pwsh"),
        // CMD and WSL have no equivalent outside Windows.
        _ => None,
    }
}

/// The user's default terminal shell on macOS/Linux: `$SHELL`, else zsh/bash/sh.
#[cfg(unix)]
fn native_default_shell() -> Option<String> {
    first_existing(&[
        env("SHELL"),
        Some("/bin/zsh".to_string()),
        Some("/bin/bash".to_string()),
        Some("/bin/sh".to_string()),
    ])
}

/// Detect every supported shell so the UI can enable/disable options.
pub fn detect_all() -> Vec<ShellInfo> {
    // Labels differ per platform: on macOS/Linux the "git-bash" slot is the
    // native Terminal. The frontend mirrors this in `shells.ts`.
    #[cfg(windows)]
    let defs = [
        ("powershell", "PowerShell"),
        ("cmd", "CMD"),
        ("git-bash", "Git Bash"),
        ("wsl", "WSL"),
    ];
    #[cfg(unix)]
    let defs = [
        ("powershell", "PowerShell"),
        ("cmd", "CMD"),
        ("git-bash", "Terminal"),
        ("wsl", "WSL"),
    ];
    defs.iter()
        .map(|(kind, label)| {
            let path = resolve(kind, None);
            ShellInfo {
                kind: kind.to_string(),
                label: label.to_string(),
                available: path.is_some(),
                path: path.unwrap_or_default(),
            }
        })
        .collect()
}

/// Build the concrete spawn spec for a shell + working directory.
pub fn build_command(
    kind: &str,
    path_override: Option<&str>,
    cwd: &str,
) -> Result<SpawnSpec, String> {
    let exe = resolve(kind, path_override)
        .ok_or_else(|| format!("Không tìm thấy shell '{kind}' trên máy này"))?;
    build_spec(kind, exe, cwd)
}

#[cfg(unix)]
fn build_spec(kind: &str, exe: String, _cwd: &str) -> Result<SpawnSpec, String> {
    let spec = match kind {
        // Native default terminal (login shell so ~/.zprofile etc. are sourced).
        "git-bash" => SpawnSpec {
            exe,
            args: vec!["-l".to_string()],
            envs: vec![("TERM".to_string(), "xterm-256color".to_string())],
            set_cwd: true,
        },
        "powershell" => SpawnSpec {
            exe,
            args: vec!["-NoLogo".to_string()],
            envs: vec![],
            set_cwd: true,
        },
        other => return Err(format!("Shell không hỗ trợ: '{other}'")),
    };
    Ok(spec)
}

#[cfg(windows)]
fn build_spec(kind: &str, exe: String, cwd: &str) -> Result<SpawnSpec, String> {
    let spec = match kind {
        "wsl" => {
            let mut args = Vec::new();
            if !cwd.is_empty() {
                args.push("--cd".to_string());
                args.push(cwd.to_string());
            }
            SpawnSpec { exe, args, envs: vec![], set_cwd: false }
        }
        "git-bash" => SpawnSpec {
            exe,
            // CHERE_INVOKING keeps the login shell in the launch dir instead of
            // cd-ing to $HOME, so the saved path is honored.
            args: vec!["--login".to_string(), "-i".to_string()],
            envs: vec![
                ("CHERE_INVOKING".to_string(), "1".to_string()),
                ("TERM".to_string(), "xterm-256color".to_string()),
            ],
            set_cwd: true,
        },
        "powershell" => SpawnSpec {
            exe,
            args: vec!["-NoLogo".to_string()],
            envs: vec![],
            set_cwd: true,
        },
        "cmd" => SpawnSpec {
            exe,
            args: vec![],
            envs: vec![],
            set_cwd: true,
        },
        other => return Err(format!("Shell không hỗ trợ: '{other}'")),
    };
    Ok(spec)
}
