import { invoke } from '@tauri-apps/api/core';
import { IS_TAURI } from './env';

/** Save the given JSON string to a user-chosen file. Returns true if saved. */
export async function exportBackup(json: string): Promise<boolean> {
  if (!IS_TAURI) {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'termdeck-backup.json';
    a.click();
    URL.revokeObjectURL(url);
    return true;
  }
  const { save } = await import('@tauri-apps/plugin-dialog');
  const path = await save({
    defaultPath: 'termdeck-backup.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!path) return false;
  await invoke('save_text', { path, contents: json });
  return true;
}

/** Open a JSON file and return its contents, or null if cancelled. */
export async function importBackup(): Promise<string | null> {
  if (!IS_TAURI) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (typeof path !== 'string') return null;
  return invoke<string>('read_text', { path });
}
