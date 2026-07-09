// Edit-in-place state: which files are open in an external editor, and the
// auto-upload pump that answers `edit://changed` events. Kept outside the main
// store — runtime-only, never persisted.
import { create } from 'zustand';
import { editOpen, editPrepare, editUnwatch, editWatch, onEditChanged } from '../ipc/edit';
import { sftpDownload, sftpUpload } from '../ipc/ssh';
import { joinPath } from '../components/pathUtils';

export interface EditRecord {
  editId: string;
  paneId: string;
  /** Remote path the temp file mirrors ('' would mean local — local edits are not tracked). */
  remotePath: string;
  tempPath: string;
  name: string;
  /** ms epoch of the last successful upload (0 = never). */
  lastUpload: number;
  uploading: boolean;
  /** A save arrived while uploading — re-upload when done. */
  queued: boolean;
  error: string | null;
}

interface EditsState {
  edits: Record<string, EditRecord>;
  upsert: (r: EditRecord) => void;
  patch: (editId: string, p: Partial<EditRecord>) => void;
  remove: (editId: string) => void;
}

export const useEdits = create<EditsState>((set) => ({
  edits: {},
  upsert: (r) => set((s) => ({ edits: { ...s.edits, [r.editId]: r } })),
  patch: (editId, p) =>
    set((s) =>
      s.edits[editId] ? { edits: { ...s.edits, [editId]: { ...s.edits[editId], ...p } } } : s
    ),
  remove: (editId) =>
    set((s) => {
      const next = { ...s.edits };
      delete next[editId];
      return { edits: next };
    }),
}));

/**
 * Open a file in an external editor. Local files open directly (saving IS
 * saving). Remote files download to %TEMP%/TermDeck-edit/<editId>/<name>,
 * open, and are watched — every save re-uploads (last-write-wins).
 * `app` = exe path; undefined = OS-default app.
 */
export async function startEdit(o: {
  paneId: string;
  remote: boolean;
  dir: string;
  name: string;
  sep: string;
  app?: string;
}): Promise<void> {
  const full = joinPath(o.dir, o.name, o.sep);
  if (!o.remote) {
    await editOpen(full, o.app);
    return;
  }
  // Re-editing the same remote file reuses its temp copy + watcher (never
  // clobbers unsaved editor state, or an in-flight upload's uploading/queued
  // state; use redownload() to refresh explicitly).
  const existing = Object.values(useEdits.getState().edits).find(
    (e) => e.paneId === o.paneId && e.remotePath === full
  );
  if (existing) {
    await editOpen(existing.tempPath, o.app);
    return;
  }
  const editId = `${o.paneId}-${Date.now().toString(36)}`;
  const temp = await editPrepare(editId, o.name);
  await sftpDownload(o.paneId, full, temp);
  await editWatch(editId, temp);
  useEdits.getState().upsert({
    editId,
    paneId: o.paneId,
    remotePath: full,
    tempPath: temp,
    name: o.name,
    lastUpload: 0,
    uploading: false,
    queued: false,
    error: null,
  });
  await editOpen(temp, o.app);
}

/** Upload the temp copy now (used by the change event AND the chip's retry). */
export async function uploadNow(editId: string): Promise<void> {
  const st = useEdits.getState();
  const rec = st.edits[editId];
  if (!rec) return;
  if (rec.uploading) {
    st.patch(editId, { queued: true });
    return;
  }
  st.patch(editId, { uploading: true, queued: false, error: null });
  try {
    await sftpUpload(rec.paneId, rec.tempPath, rec.remotePath);
    useEdits.getState().patch(editId, { uploading: false, lastUpload: Date.now() });
  } catch (e) {
    useEdits.getState().patch(editId, { uploading: false, error: String(e) });
  }
  if (useEdits.getState().edits[editId]?.queued) await uploadNow(editId);
}

/** Re-download the remote file over the temp copy (explicit refresh). */
export async function redownload(editId: string): Promise<void> {
  const rec = useEdits.getState().edits[editId];
  // Never overwrite the temp file while an upload may still be reading it.
  if (!rec || rec.uploading || rec.queued) return;
  await sftpDownload(rec.paneId, rec.remotePath, rec.tempPath);
}

export function stopEdit(editId: string): void {
  editUnwatch(editId);
  useEdits.getState().remove(editId);
}

/** Stop every edit belonging to a pane (called when the pane is removed). */
export function stopEditsForPane(paneId: string): void {
  for (const e of Object.values(useEdits.getState().edits)) {
    if (e.paneId === paneId) stopEdit(e.editId);
  }
}

let wired = false;
/** Subscribe ONCE (App mount) — survives FileBrowser unmounts on tab switches. */
export function wireEditUploads(): void {
  if (wired) return;
  wired = true;
  void onEditChanged((editId) => void uploadNow(editId));
}
