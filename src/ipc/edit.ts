// IPC for edit-in-place: temp-file prep, editor launch, save-watcher events.
import { invoke } from '@tauri-apps/api/core';
import { IS_TAURI } from './env';

export async function editPrepare(editId: string, fileName: string): Promise<string> {
  return await invoke('edit_prepare', { editId, fileName });
}
/** Open with a specific exe, or the OS default app when `app` is undefined. */
export async function editOpen(path: string, app?: string): Promise<void> {
  await invoke('edit_open', { path, app: app ?? null });
}
export async function editWatch(editId: string, path: string): Promise<void> {
  await invoke('edit_watch', { editId, path });
}
export async function editUnwatch(editId: string): Promise<void> {
  if (!IS_TAURI) return;
  await invoke('edit_unwatch', { editId });
}
/** Fires (debounced) every time a watched temp file is saved by the editor. */
export async function onEditChanged(cb: (editId: string) => void): Promise<() => void> {
  if (!IS_TAURI) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<{ editId: string }>('edit://changed', (e) => cb(e.payload.editId));
}
