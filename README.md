# TermDeck

Dashboard quản lý nhiều terminal (cmd / PowerShell / Git Bash / WSL) — gom theo **tab**, xếp thành **grid**, đặt tên từng cmd, và **khôi phục nguyên trạng** (đúng shell, đúng path, đúng bố cục) khi mở lại.

Xây bằng **Tauri v2 + React + TypeScript**, terminal thật qua **portable-pty** (Rust) + **xterm.js**.

## Yêu cầu (chỉ cần cài 1 lần)

- **Node.js** ≥ 18 (đã có)
- **Rust** (MSVC toolchain) — đã pin trong `rust-toolchain.toml`
- ⚠️ **Microsoft C++ Build Tools + Windows SDK** — *bắt buộc* để biên dịch phần Rust của Tauri trên Windows.
  Máy hiện có Visual Studio 2022 Community nhưng **chưa cài workload "Desktop development with C++"**. Cài bằng một trong hai cách:

  ```powershell
  # Cách A — thêm workload C++ vào VS 2022 Community đã có (khuyến nghị)
  & "C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe" modify `
    --installPath "C:\Program Files\Microsoft Visual Studio\2022\Community" `
    --add Microsoft.VisualStudio.Workload.NativeDesktop --includeRecommended --passive

  # Cách B — cài bộ Build Tools riêng (gọn hơn)
  winget install Microsoft.VisualStudio.2022.BuildTools `
    --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive"
  ```

- WebView2 runtime: đã có sẵn trên Windows 11.

## Chạy

```bash
npm install            # đã chạy
npm run tauri dev      # chạy app thật (cần C++ Build Tools ở trên)
npm run tauri build    # đóng gói MSI/NSIS cho Windows
```

Xem trước **giao diện** không cần Tauri (terminal chỉ là placeholder):

```bash
npm run dev            # mở http://localhost:1420 trong trình duyệt
```

## Cấu trúc

```
src/                     # Frontend React/TS
  components/            # TitleBar, TabStrip, Toolbar, Sidebar, Grid, Pane, TerminalView, StatusBar...
  dialogs/AddCmdDialog   # màn "Thêm cmd mới" (1d)
  settings/SettingsWindow# màn "Cài đặt · Phiên & Khôi phục" (1e)
  state/store.ts         # Zustand (tabs/panes/library/settings/snapshots) + persist
  ipc/                   # cầu nối tới Rust (pty, shells, dialog, window) + plugin-store
  theme/tokens.css       # design tokens trích từ mock
src-tauri/src/
  pty.rs                 # PtyManager: spawn/write/resize/kill + reader/waiter thread → Channel
  shells.rs              # dò PowerShell/CMD/Git Bash/WSL trên Windows
  lib.rs                 # đăng ký commands + plugin dialog/store
design/                  # bản mock gốc (Terminal Dashboard.dc.html) để đối chiếu pixel
```
