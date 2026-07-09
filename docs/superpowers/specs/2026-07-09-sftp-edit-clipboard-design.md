# SFTP file browser: Edit-in-place, clipboard ops, Properties (Bitvise parity)

Date: 2026-07-09 · Status: approved by user

## Goal

Bring TermDeck's dual-pane file browser up to Bitvise SFTP feature parity:
**Edit / Edit with…** (external editor + auto-upload on save), **Cut / Copy /
Paste / Move**, **Properties**, plus **Open**, **Copy path**, **New file**, and
working **local↔local copy** in two-local-pane mode.

## Current state (verified 2026-07-09)

- `FilePanel.tsx` context menu: transfer, Open (dirs only), Rename, chmod
  (remote), Select all, New folder, Refresh, Delete. Double-click on a *file*
  does nothing (`openEntry` no-ops unless `isDir`).
- `FsBackend` (FilePanel.tsx:18-31): `list/mkdir/rename/remove` +
  optional `chmod/search/home`, `sep`. Local impl = `fs_*`, remote = `sftp_*`
  (wrappers in `src/ipc/ssh.ts`).
- Transfers: `runTransfer` in `src/components/transfer.ts` (serial jobs,
  conflict prompt, pause gate, `sftp://progress`). Only local↔remote —
  two-local-pane mode has dead transfer buttons.
- Rust: all file commands in `src-tauri/src/ssh.rs` (`fs_list/mkdir/rename/
  remove/home`, `sftp_list/mkdir/rename/remove/chmod/search/home/upload/
  download`, …). `tauri-plugin-opener` installed but only `openUrl` used.
  No `notify` crate. Temp-dir pattern exists only in `download_and_run`.
- Modals: inline overlay pattern (`DeleteConfirm`, `PromptDialog`,
  `ConflictDialog`…). i18n: `src/i18n.ts` single dict `{vi,en}`, `useT()`.
- Settings: `Settings` in `src/types.ts` + `DEFAULT_SETTINGS` in
  `src/state/store.ts` (STORE_VERSION 4), UI sections in
  `src/settings/SettingsWindow.tsx`.

## Design

### 1. Edit / Edit with…

**Flow (remote file):** download to
`%TEMP%/TermDeck-edit/<paneId>/<editId>/<filename>` (keep the original
filename so editor file-type detection works) → launch editor → a Rust
`notify` watcher watches the temp file's parent dir → debounced (400 ms)
change event `edit://changed` → frontend re-uploads temp → original remote
path. Last-write-wins (same as Bitvise), no diffing.

**Flow (local file):** launch the editor directly on the file. No watcher.

**Editor resolution:**
- **Edit** → `settings.defaultEditor` (exe path) if set, else OS default app
  for the extension (opener plugin `openPath`).
- **Edit with ▸** submenu → entries from `settings.editors`
  (`{name, path}[]`) + "Browse…" (file picker; picked exe is appended to
  `settings.editors`).

**Watcher lifecycle:** an `edits` slice tracks active edits
(`{editId, paneId, remotePath, tempPath, lastUpload, status}`). Status chip
"✎ N" in the FileBrowser status bar → popover listing edits (file, last
upload time, re-upload button, stop button). Watchers stop on: manual stop,
pane removal, app exit. Re-editing an already-watched file reuses its temp
file + watch (re-download first to pick up remote changes? No — reuse as-is
to avoid clobbering unsaved local edits; the popover has a "re-download"
action instead).

**Upload failure:** chip turns red, error kept per edit in the popover;
watcher stays alive so the next save retries; manual "re-upload" button.

**New Rust (module `src-tauri/src/edit.rs`):**
- `edit_start(paneId?, remotePath?, localPath, app?) -> editId` — for remote:
  ensures temp dir, downloads, spawns editor, starts watch. For local: just
  spawns editor. `app` = exe path or None (OS default via opener).
- `edit_stop(editId)`, `edit_stop_all()`.
- Event `edit://changed { editId }` (debounced). Upload itself is done by the
  frontend via existing `sftp_upload` so progress/error handling stays in one
  place.
- New dep: `notify = "6"` (+ `#[cfg(windows)] CREATE_NO_WINDOW` when spawning
  editors with `std::process::Command`).

### 2. Cut / Copy / Paste (Move)

Internal clipboard in `FileBrowser` state (NOT the OS clipboard):
`{ op: 'copy'|'cut', side: 'left'|'right', basePath, entries: FileEntry[] }`.
Cut items render at 50 % opacity (Explorer-style). Menu gains Cut, Copy,
Paste (disabled when clipboard empty); keyboard Ctrl/Cmd+X/C/V inside the
panel. Paste matrix:

| src → dst          | Copy                          | Move (cut)                         |
|--------------------|-------------------------------|------------------------------------|
| local → local      | new `fs_copy` (recursive)     | `fs_rename`; EXDEV → copy + delete |
| remote → remote    | new `sftp_copy` (client-side stream, no temp file) | `sftp_rename` |
| local ↔ remote     | existing `runTransfer`        | transfer, then delete source on success |

All paste paths reuse the existing conflict dialog + pause gate by going
through `runTransfer` with a same-side `TransferOps` (srcList/dstList both
bound to the same backend, `doTransfer` = `fs_copy`/`sftp_copy`). Same-dir
paste of a *cut* selection is a no-op; pasting a folder into its own subtree
is rejected with an error. This also revives copy in two-local-pane mode.

**New Rust:** `fs_copy(from, to)` (single file; recursion handled by the
existing `buildJobs` walker), `sftp_copy(paneId, from, to)` (read stream →
write stream, emits `sftp://progress`).

### 3. Properties

`PropertiesDialog` (inline-overlay pattern, same as `SyncConfirm`): name,
full path, type, size (dirs: "Calculate" button → recursive size), modified
/ created, symlink target. Remote extras: uid/gid and an editable 3×3 rwx
checkbox grid + octal preview → Apply calls `sftp_chmod`. Local extras:
read-only / hidden attributes (display only). Menu item "Properties" (both
panes, single selection).

**New Rust:** `fs_stat(path)`, `sftp_stat(paneId, path)` (uid/gid/atime),
`fs_dir_size(path)`, `sftp_dir_size(paneId, path)` (bounded like
`sftp_search`, cancellable by dialog close).

### 4. Small items

- **Open**: double-click or menu "Open" on a *file*: local → opener
  `openPath` (OS default app); remote → the Edit flow (download + open +
  watch). Menu "Open" stays for dirs (navigate).
- **Copy path**: menu item, both panes; uses `src/ipc/clipboard.ts` copyText.
- **New file**: menu item → `PromptDialog` for the name → `fs_touch(path)` /
  `sftp_touch(paneId, path)`; error if the name already exists (create-new
  semantics, no truncate).

### 5. Settings & i18n

New "Editor" section in `SettingsWindow.tsx` (pattern: `ShellsSection`):
default-editor path (Browse via `pickFolder`-style file picker) + editors
list (add/remove). `Settings` gains `defaultEditor?: string` and
`editors: {name, path}[]`; add to `DEFAULT_SETTINGS`. No STORE_VERSION bump
needed: `hydrate()` already merges `{...DEFAULT_SETTINGS, ...persisted.settings}`
(store.ts:306), so new keys default cleanly. All new labels get `fb.*` /
`set.*` / `prop.*` keys in BOTH vi and en in `src/i18n.ts`.

### 6. Menu layout (final)

Transfer · **Open** · **Edit** · **Edit with ▸** · sep · **Cut** · **Copy** ·
**Paste** · Rename · Delete · sep · **New file** · New folder · sep ·
**Copy path** · chmod (remote) · **Properties** · sep · Select all · Refresh

### 7. Error handling & edge cases

- Editor exe missing/moved → clear error dialog; entry stays in settings.
- Remote file deleted while editing → upload recreates it (upload is
  create-or-truncate).
- Editors that save via rename-replace (Notepad++, VS Code): watcher watches
  the parent dir and matches the filename, debounce 400 ms.
- Temp files are swept at app start (stale `TermDeck-edit` subdirs older than
  7 days). `edit_stop` does NOT delete the temp file — the editor may still
  hold it open (deleting an open file fails on Windows anyway).
- All new background `std::process::Command` spawns use `CREATE_NO_WINDOW`
  on Windows.

### 8. Verification

- `npx tsc --noEmit` and `cargo check` pass.
- Manual: edit a remote file with Notepad++ → save → verify content on the
  server updates; edit with OS-default; local edit; kill network → save →
  red chip → reconnect → save again uploads.
- Cut/copy/paste all 6 directions incl. two-local-pane; cut-into-own-subtree
  rejected; conflict dialog appears on name collision.
- Properties on local/remote file + dir (calculate size), chmod grid applies.
- New file both sides; Copy path pastes correctly; double-click opens files.
