import type { ShellKind } from './types';

export interface ShellMeta {
  kind: ShellKind;
  label: string;
  badge: string;
  /** CSS variable holding the shell's accent color. */
  colorVar: string;
}

/** Rough platform sniff from the webview UA — enough to pick shell labels. */
const UA = typeof navigator !== 'undefined' ? navigator.userAgent : '';
export const IS_MAC = /Mac|iPhone|iPad/i.test(UA);
export const IS_WIN = /Win/i.test(UA);

// On macOS/Linux, CMD/Git Bash/WSL don't exist. The backend repurposes the
// `git-bash` slot as the native default terminal (see src-tauri/src/shells.rs),
// so we surface it here as "Terminal" and hide the Windows-only shells.
const WIN_SHELLS: Record<ShellKind, ShellMeta> = {
  powershell: { kind: 'powershell', label: 'PowerShell', badge: 'PS', colorVar: '--sh-ps' },
  cmd: { kind: 'cmd', label: 'CMD', badge: '>_', colorVar: '--sh-cmd' },
  'git-bash': { kind: 'git-bash', label: 'Git Bash', badge: 'GB', colorVar: '--sh-gb' },
  wsl: { kind: 'wsl', label: 'WSL', badge: 'W', colorVar: '--sh-wsl' },
};

const UNIX_SHELLS: Record<ShellKind, ShellMeta> = {
  ...WIN_SHELLS,
  'git-bash': { kind: 'git-bash', label: 'Terminal', badge: '>_', colorVar: '--sh-cmd' },
};

export const SHELLS: Record<ShellKind, ShellMeta> = IS_WIN ? WIN_SHELLS : UNIX_SHELLS;

// Which shells to show (and in what order) in the picker / settings.
export const SHELL_ORDER: ShellKind[] = IS_WIN
  ? ['powershell', 'cmd', 'git-bash', 'wsl']
  : ['git-bash', 'powershell'];
