import { invoke } from '@tauri-apps/api/core';
import type { ShellInfo } from '../types';
import { IS_TAURI } from './env';

/** Detect available shells. Falls back to "all available" in browser preview. */
export async function detectShells(): Promise<ShellInfo[]> {
  if (!IS_TAURI) {
    return [
      { kind: 'powershell', label: 'PowerShell', path: '', available: true },
      { kind: 'cmd', label: 'CMD', path: '', available: true },
      { kind: 'git-bash', label: 'Git Bash', path: '', available: true },
      { kind: 'wsl', label: 'WSL', path: '', available: true },
    ];
  }
  return invoke<ShellInfo[]>('detect_shells');
}

/** Native folder picker for the "Chọn…" button. */
export async function pickFolder(defaultPath?: string): Promise<string | null> {
  if (!IS_TAURI) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const res = await open({ directory: true, multiple: false, defaultPath });
  return typeof res === 'string' ? res : null;
}

/** Custom-titlebar window controls. */
export const windowControls = {
  async minimize() {
    if (!IS_TAURI) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().minimize();
  },
  async toggleMaximize() {
    if (!IS_TAURI) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().toggleMaximize();
  },
  async close() {
    if (!IS_TAURI) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
  },
};
