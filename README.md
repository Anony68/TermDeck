<div align="center">

# TermDeck

**A terminal management dashboard — bring cmd / PowerShell / Git Bash / WSL and remote SSH together in one tidy place.**

Run many real terminals in a single window: split them into **tabs**, arrange them in a **grid**, group them by **project**, watch each one's **CPU / RAM / uptime**, and **restore everything exactly** the next time you open it.

Lightweight (~3.5 MB installer) thanks to **Tauri v2 + Rust + React** — not Electron.

[**⬇ Download the latest release**](https://github.com/Anony68/TermDeck/releases) · Windows · macOS · Linux

![TermDeck](docs/screenshot.png)

</div>

---

## What is TermDeck?

When you juggle several projects at once — each with a few terminals (dev server, watcher, git, logs…) — scattered terminal windows are easy to lose and mix up. **TermDeck** turns them into a single *control panel*: **real** terminals (type commands, run processes exactly as usual) laid out neatly in a grid, grouped by project, and always brought back to where you left off. It also speaks **SSH** and ships a built-in **SFTP file manager**, so remote servers live right next to your local shells.

## Features

### Terminals
- **Real terminals, many kinds** — PowerShell, CMD, Git Bash, WSL. Available shells are auto-detected.
- **SSH terminals** — connect to remote hosts with **password or private key (.pem)** auth. Passwords/passphrases are stored in the **OS credential store** (Windows Credential Manager / Keychain), never in the config file. Host keys are pinned on first use (TOFU) to guard against MITM.
- **Flexible grid** — 6 layout presets (1, 1×2, 2×1, 2×2, 1-big + 2, 3×2), **drag-and-drop** to rearrange, and the grid grows automatically as you add terminals.
- **Tabs are views** — each tab is its own arrangement. Terminals keep **running in the background** even when hidden; show/hide freely, **pin** one to appear in every tab. Tabs support drag-reorder and pinning.
- **Terminal list = the manager** — running/stopped status, **Stop / Restart** buttons, right-click to **Edit / Pin / Stop / Delete**.
- **Copy & paste that works** — select + right-click (or **Ctrl+C**) to copy, right-click with no selection (or **Ctrl+V**) to paste; Ctrl+C with no selection still sends SIGINT. Shift+right-click opens the full context menu (Copy / Paste / Select all / Clear).

### Claude Code integration
- **Auto-detection** — a terminal running Claude Code shows a spark icon on the pane header, its tab and the sidebar; it **pulses while Claude is working** and stays still when idle, so you can tell at a glance which session is busy.
- **Quick commands** — one-click chips + a menu on the pane bar for `/remote-control`, `/resume`, `/compact`, `Esc`, and launch variants (`claude`, `claude -c`, `claude -r`, `claude update`).

### Built-in SFTP file manager
- **Dual-pane browser** (Bitvise-style) — local filesystem on one side, remote SFTP on the other. Browse, filter, create / rename / delete.
- **Recursive upload & download** — transfer whole directory trees with a live progress bar and a per-batch summary (files transferred / skipped).
- **Conflict handling** — when a file already exists, choose **Overwrite / Overwrite all / Skip / Skip all / Cancel**.
- **One-way directory sync** (rclone-style mirror) — a **Sync** button on each column mirrors *Local ▶ Remote* or *Remote ▶ Local*: uploads new/changed files (by size or mtime) and removes extras on the target, behind a confirmation dialog.
- **Fast navigation** — marquee drag-select, type-ahead jump, **Backspace** for parent folder, **Delete** to remove (with a confirm popup), **F5** to reload the tree. Each pane remembers its last folder.

### Workspace & polish
- **Group by project** — save projects (name + folder) for quick picking; the sidebar groups terminals per project.
- **Per-terminal stats** — ⏱ uptime · CPU% · RAM (summed across the whole child process tree, e.g. `npm run dev` includes its `node` process).
- **Session restore** — reopens the right shell, folder, layout and name. Snapshots let you roll back.
- **Tuning** — terminal font size, whole-app zoom, and a **GitHub-based update check** with one-click download-and-install.

## Download & install

Head to [**Releases**](https://github.com/Anony68/TermDeck/releases) and grab the installer for your OS:

| OS | File |
|---|---|
| Windows | `TermDeck_x.y.z_x64-setup.exe` (NSIS) or `.msi` |
| macOS | `TermDeck_x.y.z_*.dmg` (Intel & Apple Silicon) |
| Linux | `.AppImage` / `.deb` |

## Tech stack

**Tauri v2** (app shell, WebView2/WebKit) · **Rust** (`portable-pty` → ConPTY for local shells, `ssh2`/libssh2 for SSH & SFTP, `keyring` for secrets, `sysinfo` for stats) · **React + TypeScript + Vite** · **xterm.js** (terminal rendering) · **Zustand** + `@tauri-apps/plugin-store` (state & session persistence).

## Development

Requirements: **Node.js ≥ 18**, **Rust** (Windows needs **MSVC** + **Microsoft C++ Build Tools** + **Windows SDK**; macOS needs Xcode CLT; Linux needs `webkit2gtk`, etc.), and WebView2 (bundled with Windows 11).

```bash
npm install
npm run tauri dev      # run the app in dev mode
npm run tauri build    # bundle an installer for the current OS
npm run dev            # (optional) UI-only preview in a browser; terminals are placeholders
```

> Windows note: the project uses the **MSVC** toolchain. If `rustup` defaults to `-gnu`, set an override:
> `rustup override set stable-x86_64-pc-windows-msvc`

Cross-platform releases are built automatically by **GitHub Actions** (`.github/workflows/release.yml`) when a `v*` tag is pushed.

## Project structure

```
src/                       # React/TS frontend
  components/              # TitleBar, TabStrip, Toolbar, Sidebar, Grid, Pane,
                           # KeepAliveTerminal, TerminalLayer, StatusBar, ContextMenu,
                           # ClaudeIcon, FileBrowser, FilePanel (SFTP dual-pane)…
  components/transfer.ts   # recursive upload/download with conflict resolution
  components/sync.ts       # rclone-style one-way directory mirror
  dialogs/AddCmdDialog     # add/edit a terminal (shell / SSH / file-browser types)
  settings/SettingsWindow  # Settings: General, Projects, Session & Restore, Layout, Shells, Shortcuts, Updates
  state/store.ts           # Zustand (tabs / panes / projects / settings / snapshots) + persist
  ipc/                     # Rust bridge: pty, ssh (SSH/SFTP), session, clipboard, shells, dialog, window, stats, update
src-tauri/src/
  pty.rs                   # PtyManager: spawn/write/resize/kill + reader/waiter thread → Channel
  ssh.rs                   # SSH terminals + SFTP + local FS commands (ssh2/libssh2, keyring, host-key pinning)
  shells.rs                # detect PowerShell / CMD / Git Bash / WSL
  lib.rs                   # commands + plugins (dialog/store/opener/clipboard) + CPU/RAM sampler + Claude detection
```

## License

Internal / personal use. © Anony68.
