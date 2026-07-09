import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useStore } from '../state/store';
import type { Pane } from '../types';
import type { FileEntry, TransferProgress } from '../ipc/ssh';
import {
  fsList,
  fsMkdir,
  fsRename,
  fsRemove,
  fsHome,
  fsTouch,
  fsStat,
  fsDirSize,
  fsCopy,
  sftpConnect,
  sftpHome,
  sftpList,
  sftpMkdir,
  sftpRename,
  sftpRemove,
  sftpChmod,
  sftpSearch,
  sftpUpload,
  sftpDownload,
  sftpTouch,
  sftpStat,
  sftpDirSize,
  sftpCopy,
  onSftpProgress,
} from '../ipc/ssh';
import { FilePanel, type FsBackend } from './FilePanel';
import { IconSwap, IconPlay, IconPause, IconClose, IconCheck, IconPencil } from './icons';
import { useEdits, uploadNow, redownload, stopEdit, startEdit } from '../state/edits';
import { editOpen } from '../ipc/edit';
import { joinPath } from './pathUtils';
import {
  runTransfer,
  type ConflictAction,
  type TransferOps,
  type TransferSummary,
} from './transfer';
import {
  planSync,
  runSync,
  planBiSync,
  runBiSync,
  type SyncOps,
  type SyncPlan,
  type SyncSummary,
  type BiSyncOps,
  type BiSyncPlan,
  type BiSyncSummary,
} from './sync';
import { IS_TAURI } from '../ipc/env';
import { IS_WIN } from '../shells';
import { useT } from '../i18n';

/** Local filesystem separator: '\' on Windows, '/' on macOS/Linux. */
const LOCAL_SEP = IS_WIN ? '\\' : '/';

type Conn = 'connecting' | 'ready' | 'error' | 'local-only';
/** Sync direction: 'up' = local ▶ remote, 'down' = remote ▶ local. */
type SyncDir = 'up' | 'down';

/** Which panel the clipboard's entries came from. */
type ClipSide = 'left' | 'right';
interface Clip {
  op: 'copy' | 'cut';
  side: ClipSide;
  base: string;
  sep: string;
  entries: FileEntry[];
}

/**
 * Dual-pane file manager (Bitvise-style). Left = local FS. Right = remote SFTP
 * (only when the pane carries SSH settings); otherwise a second local pane so the
 * Browser type is useful even without SSH. Transfers stream with a progress bar.
 */
export function FileBrowser({ pane }: { pane: Pane }) {
  const setBrowserPath = useStore((s) => s.setBrowserPath);
  const t = useT();
  const hasRemote = !!pane.ssh && pane.kind === 'browser';
  const [conn, setConn] = useState<Conn>(hasRemote ? 'connecting' : 'local-only');
  const [connErr, setConnErr] = useState<string | null>(null);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [batch, setBatch] = useState<{ done: number; total: number; verb: string } | null>(null);
  const [summary, setSummary] = useState<(TransferSummary & { verb: string }) | null>(null);
  const [conflict, setConflict] = useState<{ name: string } | null>(null);
  const [planning, setPlanning] = useState(false);
  const [syncPlan, setSyncPlan] = useState<
    { plan: SyncPlan; src: string; dst: string; ops: SyncOps; dir: SyncDir } | null
  >(null);
  const [syncSummary, setSyncSummary] = useState<(SyncSummary & { dir: SyncDir }) | null>(null);
  const [biPlan, setBiPlan] = useState<{ plan: BiSyncPlan; local: string; remote: string } | null>(null);
  const [biSummary, setBiSummary] = useState<BiSyncSummary | null>(null);
  const [localHome, setLocalHome] = useState<string | null>(null);
  // Remote start dir resolved after connect (config path if it exists, else ~).
  const [remoteStart, setRemoteStart] = useState<string | null>(null);
  const [leftKey, setLeftKey] = useState(0);
  const [rightKey, setRightKey] = useState(0);
  const [clip, setClip] = useState<Clip | null>(null);
  const edits = useEdits((s) => s.edits);
  const myEdits = Object.values(edits).filter((e) => e.paneId === pane.id);
  const editErr = myEdits.some((e) => e.error);
  const [editsOpen, setEditsOpen] = useState(false);

  // Live current-dir of each side, so a transfer knows the opposite destination.
  const localCwd = useRef(pane.browserLocalPath ?? '');
  const remoteCwd = useRef(pane.browserRemotePath ?? pane.ssh?.remotePath ?? '/');
  // Resolver for the pending conflict prompt (set while the modal is open).
  const conflictResolve = useRef<((a: ConflictAction) => void) | null>(null);
  // Set true to abort the running transfer batch before the next file.
  const cancelRef = useRef(false);
  // While true the batch holds between files (pause/resume).
  const pausedRef = useRef(false);
  // Guards doPaste against overlapping invocations (the pure-rename fast path
  // never sets `busy`, so a fast double Ctrl+V could otherwise race).
  const pasteRef = useRef(false);
  const [paused, setPaused] = useState(false);
  // OS drag-and-drop (C3): upload files dropped from Explorer onto the pane.
  const rootRef = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    void fsHome().then((h) => setLocalHome(h || ''));
  }, []);

  // Connect SFTP + subscribe to transfer progress.
  useEffect(() => {
    let alive = true;
    let un: (() => void) | null = null;
    if (hasRemote && pane.ssh && IS_TAURI) {
      setConn('connecting');
      sftpConnect(pane.id, pane.ssh)
        .then(async () => {
          if (!alive) return;
          // Resolve the start dir: prefer the saved/config path, else fall back
          // to the remote home (~) so a missing path never breaks the panel.
          const prefer = pane.browserRemotePath ?? pane.ssh?.remotePath ?? '';
          let start = prefer || '/';
          try {
            start = await sftpHome(pane.id, prefer);
          } catch {
            /* keep the fallback */
          }
          if (!alive) return;
          remoteCwd.current = start;
          setRemoteStart(start);
          setConn('ready');
        })
        .catch((e) => {
          if (!alive) return;
          setConn('error');
          setConnErr(String(e));
        });
    }
    void onSftpProgress((p) => {
      if (p.paneId === pane.id) setProgress(p);
    }).then((fn) => {
      if (alive) un = fn;
      else fn();
    });
    return () => {
      alive = false;
      un?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id]);

  // Stable across re-renders (Pane re-renders every second for stats/uptime);
  // otherwise FilePanel's load effect would re-fire and reset path + selection.
  const localBackend = useMemo<FsBackend>(
    () => ({
      list: fsList,
      mkdir: fsMkdir,
      rename: fsRename,
      remove: fsRemove,
      home: fsHome,
      touch: fsTouch,
      stat: fsStat,
      dirSize: fsDirSize,
      sep: LOCAL_SEP,
    }),
    []
  );
  const remoteBackend = useMemo<FsBackend>(
    () => ({
      list: (p) => sftpList(pane.id, p),
      mkdir: (p) => sftpMkdir(pane.id, p),
      rename: (f, t) => sftpRename(pane.id, f, t),
      remove: (p, d) => sftpRemove(pane.id, p, d),
      chmod: (p, m) => sftpChmod(pane.id, p, m),
      search: (root, q) => sftpSearch(pane.id, root, q),
      home: () => sftpHome(pane.id, ''),
      touch: (p) => sftpTouch(pane.id, p),
      stat: (p) => sftpStat(pane.id, p),
      dirSize: (p) => sftpDirSize(pane.id, p),
      sep: '/',
    }),
    [pane.id]
  );

  // Edit: local = open the file itself; remote = temp-download + watch + auto-upload.
  const editLocal = useMemo(
    () => (e: FileEntry, dir: string, app?: string) =>
      void startEdit({ paneId: pane.id, remote: false, dir, name: e.name, sep: LOCAL_SEP, app }).catch(
        (err) => alert(t('fb.errEdit', { err: String(err) }))
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pane.id]
  );
  const editRemote = useMemo(
    () => (e: FileEntry, dir: string, app?: string) =>
      void startEdit({ paneId: pane.id, remote: true, dir, name: e.name, sep: '/', app }).catch(
        (err) => alert(t('fb.errEdit', { err: String(err) }))
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pane.id]
  );
  // Open: local = OS default app; remote "Open" = the edit flow (Bitvise behavior).
  const openLocal = useMemo(
    () => (e: FileEntry, dir: string) =>
      void editOpen(joinPath(dir, e.name, LOCAL_SEP)).catch((err) => alert(t('fb.errEdit', { err: String(err) }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const openRemote = useMemo(() => (e: FileEntry, dir: string) => editRemote(e, dir, undefined), [editRemote]);

  // Track + persist each side's directory (restored on reopen / app restart).
  const setLocalCwd = useMemo(
    () => (p: string) => {
      localCwd.current = p;
      setBrowserPath(pane.id, 'local', p);
    },
    [pane.id, setBrowserPath]
  );
  const setRemoteCwd = useMemo(
    () => (p: string) => {
      remoteCwd.current = p;
      setBrowserPath(pane.id, 'remote', p);
    },
    [pane.id, setBrowserPath]
  );

  // Ask the user how to resolve a name conflict; resolves when they click.
  const askConflict = (name: string): Promise<ConflictAction> =>
    new Promise((resolve) => {
      conflictResolve.current = resolve;
      setConflict({ name });
    });
  const resolveConflict = (action: ConflictAction) => {
    setConflict(null);
    conflictResolve.current?.(action);
    conflictResolve.current = null;
  };

  const uploadOps: TransferOps = {
    srcList: fsList,
    srcSep: LOCAL_SEP,
    dstList: (d) => sftpList(pane.id, d),
    dstSep: '/',
    dstMkdir: (d) => sftpMkdir(pane.id, d),
    doTransfer: (s, d) => sftpUpload(pane.id, s, d),
  };
  const downloadOps: TransferOps = {
    srcList: (d) => sftpList(pane.id, d),
    srcSep: '/',
    dstList: fsList,
    dstSep: LOCAL_SEP,
    dstMkdir: fsMkdir,
    doTransfer: (s, d) => sftpDownload(pane.id, s, d),
  };

  const runBatch = async (
    entries: FileEntry[],
    fromDir: string,
    toDir: string,
    ops: TransferOps,
    verb: string
  ): Promise<TransferSummary | null> => {
    setBusy(true);
    setSummary(null);
    cancelRef.current = false;
    pausedRef.current = false;
    setPaused(false);
    setBatch({ done: 0, total: entries.length, verb });
    try {
      const result = await runTransfer(entries, fromDir, toDir, ops, {
        onConflict: askConflict,
        onProgress: (done, total) => setBatch({ done, total, verb }),
        shouldCancel: () => cancelRef.current,
        shouldPause: () => pausedRef.current,
      });
      setSummary({ ...result, verb });
      return result;
    } catch (e) {
      alert(t('fb.transferErr', { err: String(e) }));
      return null;
    } finally {
      setBusy(false);
      setBatch(null);
      setProgress(null);
      setLeftKey((k) => k + 1);
      setRightKey((k) => k + 1);
    }
  };

  const onUpload = (entries: FileEntry[], fromLocal: string) =>
    void runBatch(entries, fromLocal, remoteCwd.current, uploadOps, t('fb.verbUpload'));
  const onDownload = (entries: FileEntry[], fromRemote: string) =>
    void runBatch(entries, fromRemote, localCwd.current, downloadOps, t('fb.verbDownload'));

  const localCopyOps: TransferOps = {
    srcList: fsList,
    srcSep: LOCAL_SEP,
    dstList: fsList,
    dstSep: LOCAL_SEP,
    dstMkdir: fsMkdir,
    doTransfer: (s, d) => fsCopy(s, d),
  };
  const remoteCopyOps: TransferOps = {
    srcList: (d) => sftpList(pane.id, d),
    srcSep: '/',
    dstList: (d) => sftpList(pane.id, d),
    dstSep: '/',
    dstMkdir: (d) => sftpMkdir(pane.id, d),
    doTransfer: (s, d) => sftpCopy(pane.id, s, d),
  };

  /** 'remote' only when this browser HAS a remote and it's the right side. */
  const kindOf = (side: ClipSide): 'local' | 'remote' =>
    side === 'right' && hasRemote ? 'remote' : 'local';

  const doPaste = async (dstSide: ClipSide, dstDir: string) => {
    if (!clip || busy || pasteRef.current) return;
    pasteRef.current = true;
    try {
      const srcKind = kindOf(clip.side);
      const dstKind = kindOf(dstSide);
      const sameKind = srcKind === dstKind;
      const dstSep = dstKind === 'local' ? LOCAL_SEP : '/';

      // Same physical directory (regardless of which panel it's viewed in): pasting
      // would make src === dst per entry — on SFTP the create() truncates the file
      // being read, destroying it. No-op instead; a cut just clears the clipboard.
      const normPath = (p: string, kind: 'local' | 'remote') => {
        let s = p.replace(/[\\/]+$/, '');
        if (kind === 'local') s = s.toLowerCase().replace(/\//g, '\\');
        return s;
      };
      if (sameKind && normPath(clip.base, srcKind) === normPath(dstDir, dstKind)) {
        if (clip.op === 'cut') setClip(null);
        return;
      }
      if (sameKind) {
        for (const en of clip.entries) {
          if (!en.isDir) continue;
          const src = joinPath(clip.base, en.name, clip.sep);
          if (dstDir === src || dstDir.startsWith(src + clip.sep)) {
            alert(t('fb.errPasteSub'));
            return;
          }
        }
      }

      const ops: TransferOps = sameKind
        ? srcKind === 'local'
          ? localCopyOps
          : remoteCopyOps
        : srcKind === 'local'
          ? uploadOps
          : downloadOps;
      const srcBackend = srcKind === 'local' ? localBackend : remoteBackend;

      if (clip.op === 'cut' && sameKind) {
        // Fast path: same-backend move = rename. Fall back to copy+delete per entry
        // (name conflict at the target, or EXDEV across drives).
        const viaCopy: FileEntry[] = [];
        const dstNames = new Set(
          (await ops.dstList(dstDir).catch(() => [] as FileEntry[])).map((x) => x.name)
        );
        for (const en of clip.entries) {
          if (dstNames.has(en.name)) {
            viaCopy.push(en);
            continue;
          }
          try {
            await srcBackend.rename(joinPath(clip.base, en.name, clip.sep), joinPath(dstDir, en.name, dstSep));
          } catch {
            viaCopy.push(en);
          }
        }
        if (viaCopy.length) {
          const res = await runBatch(viaCopy, clip.base, dstDir, ops, t('fb.verbMove'));
          // Delete sources ONLY on a fully clean batch (no fail/skip/cancel) — never lose data.
          if (res && !res.cancelled && res.failed === 0 && res.skipped === 0) {
            for (const en of viaCopy) {
              try {
                await srcBackend.remove(joinPath(clip.base, en.name, clip.sep), en.isDir);
              } catch {
                /* leave the source in place */
              }
            }
          }
        }
        setLeftKey((k) => k + 1);
        setRightKey((k) => k + 1);
      } else {
        const verb = clip.op === 'cut' ? t('fb.verbMove') : t('fb.verbCopy');
        const res = await runBatch(clip.entries, clip.base, dstDir, ops, verb);
        if (clip.op === 'cut' && res && !res.cancelled && res.failed === 0 && res.skipped === 0) {
          for (const en of clip.entries) {
            try {
              await srcBackend.remove(joinPath(clip.base, en.name, clip.sep), en.isDir);
            } catch {
              /* leave the source in place */
            }
          }
          setLeftKey((k) => k + 1);
          setRightKey((k) => k + 1);
        }
      }
      setClip(null);
    } finally {
      pasteRef.current = false;
    }
  };

  // Upload files dropped from the OS file explorer onto this pane (grouped by
  // their source folder so the transfer engine's recursion + conflict handling
  // are reused). Directories drop in whole.
  const onExternalDrop = async (paths: string[]) => {
    if (!hasRemote || conn !== 'ready') return;
    const byParent = new Map<string, string[]>();
    for (const p of paths) {
      const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
      if (i < 0) continue;
      const dir = p.slice(0, i);
      const name = p.slice(i + 1);
      const arr = byParent.get(dir) ?? [];
      arr.push(name);
      byParent.set(dir, arr);
    }
    for (const [dir, names] of byParent) {
      const all = await fsList(dir).catch(() => [] as FileEntry[]);
      const entries = all.filter((e) => names.includes(e.name));
      if (entries.length) await runBatch(entries, dir, remoteCwd.current, uploadOps, t('fb.verbUpload'));
    }
  };

  // Subscribe to the webview's drag-drop; each pane handles drops within its rect.
  useEffect(() => {
    if (!IS_TAURI || !hasRemote) return;
    let alive = true;
    let un: (() => void) | null = null;
    const inRoot = (pos: { x: number; y: number }): boolean => {
      const el = rootRef.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = pos.x / dpr;
      const y = pos.y / dpr;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    void import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((e) => {
          const p = e.payload;
          if (p.type === 'over') setDragOver(inRoot(p.position));
          else if (p.type === 'leave') setDragOver(false);
          else if (p.type === 'drop') {
            const over = inRoot(p.position);
            setDragOver(false);
            if (over) void onExternalDrop(p.paths);
          }
        })
      )
      .then((fn) => {
        if (alive) un = fn;
        else fn();
      });
    return () => {
      alive = false;
      un?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRemote, conn]);

  // One-way mirror ops for each direction. 'up' = local ▶ remote (upload),
  // 'down' = remote ▶ local (download). Both delete extras on the target.
  const upSyncOps: SyncOps = {
    srcList: fsList,
    srcSep: LOCAL_SEP,
    dstList: (d) => sftpList(pane.id, d),
    dstSep: '/',
    dstMkdir: (d) => sftpMkdir(pane.id, d),
    dstRemove: (p, isDir) => sftpRemove(pane.id, p, isDir),
    doTransfer: (s, d) => sftpUpload(pane.id, s, d),
  };
  const downSyncOps: SyncOps = {
    srcList: (d) => sftpList(pane.id, d),
    srcSep: '/',
    dstList: fsList,
    dstSep: LOCAL_SEP,
    dstMkdir: fsMkdir,
    dstRemove: fsRemove,
    doTransfer: (s, d) => sftpDownload(pane.id, s, d),
  };

  const onSyncClick = async (dir: SyncDir) => {
    if (planning || busy) return;
    const src = dir === 'up' ? localCwd.current : remoteCwd.current;
    const dst = dir === 'up' ? remoteCwd.current : localCwd.current;
    const ops = dir === 'up' ? upSyncOps : downSyncOps;
    if (!src || !dst) return;
    setPlanning(true);
    setSummary(null);
    setSyncSummary(null);
    try {
      const plan = await planSync(src, dst, ops);
      setSyncPlan({ plan, src, dst, ops, dir });
    } catch (e) {
      alert(t('sync.errPlan', { err: String(e) }));
    } finally {
      setPlanning(false);
    }
  };
  // Two-way sync (C5): newer-wins merge, no deletions.
  const biSyncOps: BiSyncOps = {
    localList: fsList,
    remoteList: (d) => sftpList(pane.id, d),
    localMkdir: fsMkdir,
    remoteMkdir: (d) => sftpMkdir(pane.id, d),
    upload: (l, r) => sftpUpload(pane.id, l, r),
    download: (r, l) => sftpDownload(pane.id, r, l),
    localSep: LOCAL_SEP,
    remoteSep: '/',
  };
  const onBiSyncClick = async () => {
    if (planning || busy) return;
    const local = localCwd.current;
    const remote = remoteCwd.current;
    if (!local || !remote) return;
    setPlanning(true);
    setSummary(null);
    setSyncSummary(null);
    setBiSummary(null);
    try {
      const plan = await planBiSync(local, remote, biSyncOps);
      setBiPlan({ plan, local, remote });
    } catch (e) {
      alert(t('sync.errPlan', { err: String(e) }));
    } finally {
      setPlanning(false);
    }
  };
  const runBiSyncNow = async () => {
    if (!biPlan) return;
    const { plan, local, remote } = biPlan;
    setBiPlan(null);
    setBusy(true);
    cancelRef.current = false;
    pausedRef.current = false;
    setPaused(false);
    setBatch({ done: 0, total: plan.uploads.length + plan.downloads.length, verb: t('fb.verbSync') });
    try {
      const result = await runBiSync(local, remote, plan, biSyncOps, {
        onProgress: (done, total) => setBatch({ done, total, verb: t('fb.verbSync') }),
        shouldCancel: () => cancelRef.current,
        shouldPause: () => pausedRef.current,
      });
      setBiSummary(result);
    } catch (e) {
      alert(t('sync.errRun', { err: String(e) }));
    } finally {
      setBusy(false);
      setBatch(null);
      setProgress(null);
      setLeftKey((k) => k + 1);
      setRightKey((k) => k + 1);
    }
  };

  const runSyncNow = async () => {
    if (!syncPlan) return;
    const { plan, src, dst, ops, dir } = syncPlan;
    setSyncPlan(null);
    setBusy(true);
    cancelRef.current = false;
    pausedRef.current = false;
    setPaused(false);
    setBatch({ done: 0, total: plan.uploads.length, verb: t('fb.verbSync') });
    try {
      const result = await runSync(src, dst, plan, ops, {
        onProgress: (done, total) => setBatch({ done, total, verb: t('fb.verbSync') }),
        shouldCancel: () => cancelRef.current,
        shouldPause: () => pausedRef.current,
      });
      setSyncSummary({ ...result, dir });
    } catch (e) {
      alert(t('sync.errRun', { err: String(e) }));
    } finally {
      setBusy(false);
      setBatch(null);
      setProgress(null);
      setLeftKey((k) => k + 1);
      setRightKey((k) => k + 1);
    }
  };

  if (!IS_TAURI) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
        {t('fb.onlyTauri')}
      </div>
    );
  }

  // Prefer the saved directory; fall back to home once it loads.
  const initialLocal = pane.browserLocalPath ?? localHome;

  return (
    <div
      ref={rootRef}
      style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, position: 'relative' }}
    >
      {dragOver && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 30,
            pointerEvents: 'none',
            display: 'grid',
            placeItems: 'center',
            background: 'var(--accent-soft)',
            border: '2px dashed var(--accent)',
            borderRadius: 8,
            font: '700 14px var(--font-ui)',
            color: 'var(--accent)',
          }}
        >
          {t('fb.dropUpload')}
        </div>
      )}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, minWidth: 0 }}>
        {initialLocal !== null && (
          <FilePanel
            key={`local-${initialLocal}`}
            title={t('fb.local')}
            backend={localBackend}
            initialPath={initialLocal}
            accent="var(--sh-ps)"
            transferLabel={hasRemote ? t('fb.upload') : t('fb.copyRight')}
            transferDir="right"
            refreshKey={leftKey}
            onPathChange={setLocalCwd}
            onTransfer={(entries, from) =>
              hasRemote
                ? onUpload(entries, from)
                : void runBatch(entries, from, remoteCwd.current, localCopyOps, t('fb.verbCopy'))
            }
            syncLabel={planning ? t('fb.syncBusy') : t('fb.syncUp')}
            onSync={hasRemote && conn === 'ready' && !busy ? () => onSyncClick('up') : undefined}
            onEditFile={editLocal}
            onOpenFile={openLocal}
            onCut={(entries, dir) => setClip({ op: 'cut', side: 'left', base: dir, sep: LOCAL_SEP, entries })}
            onCopy={(entries, dir) => setClip({ op: 'copy', side: 'left', base: dir, sep: LOCAL_SEP, entries })}
            onPaste={(dir) => void doPaste('left', dir)}
            canPaste={!!clip && !busy}
            cutMarks={clip?.op === 'cut' && clip.side === 'left' ? { dir: clip.base, names: clip.entries.map((e) => e.name) } : null}
          />
        )}
        <div style={{ width: 1, background: 'var(--border-3)' }} />
        {hasRemote ? (
          conn === 'ready' ? (
            <FilePanel
              key={`remote-${remoteStart ?? ''}`}
              title={t('fb.remote', { user: pane.ssh?.user ?? '', host: pane.ssh?.host ?? '' })}
              backend={remoteBackend}
              initialPath={remoteStart ?? pane.browserRemotePath ?? pane.ssh?.remotePath ?? '/'}
              accent="var(--accent)"
              transferLabel={t('fb.download')}
              transferDir="left"
              refreshKey={rightKey}
              onPathChange={setRemoteCwd}
              onTransfer={(entries, from) => onDownload(entries, from)}
              syncLabel={planning ? t('fb.syncBusyDown') : t('fb.syncDown')}
              onSync={!busy ? () => onSyncClick('down') : undefined}
              onEditFile={editRemote}
              onOpenFile={openRemote}
              onCut={(entries, dir) => setClip({ op: 'cut', side: 'right', base: dir, sep: hasRemote ? '/' : LOCAL_SEP, entries })}
              onCopy={(entries, dir) => setClip({ op: 'copy', side: 'right', base: dir, sep: hasRemote ? '/' : LOCAL_SEP, entries })}
              onPaste={(dir) => void doPaste('right', dir)}
              canPaste={!!clip && !busy}
              cutMarks={clip?.op === 'cut' && clip.side === 'right' ? { dir: clip.base, names: clip.entries.map((e) => e.name) } : null}
            />
          ) : (
            <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 20, textAlign: 'center' }}>
              <div>
                <div
                  style={{
                    font: '600 12px var(--font-ui)',
                    color: conn === 'error' ? 'var(--danger)' : 'var(--text-2)',
                  }}
                >
                  {conn === 'connecting' ? t('fb.connecting') : t('fb.notReady')}
                </div>
                {connErr && (
                  <div
                    style={{
                      marginTop: 8,
                      font: '400 11px var(--font-mono)',
                      color: 'var(--text-muted)',
                      maxWidth: 340,
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {connErr}
                  </div>
                )}
              </div>
            </div>
          )
        ) : (
          initialLocal !== null && (
            <FilePanel
              key={`local2-${pane.browserRemotePath ?? initialLocal}`}
              title={t('fb.local2')}
              backend={localBackend}
              initialPath={pane.browserRemotePath ?? initialLocal}
              accent="var(--sh-ps)"
              transferLabel={t('fb.copyLeft')}
              transferDir="left"
              refreshKey={rightKey}
              onPathChange={setRemoteCwd}
              onTransfer={(entries, from) =>
                void runBatch(entries, from, localCwd.current, localCopyOps, t('fb.verbCopy'))
              }
              onEditFile={editLocal}
              onOpenFile={openLocal}
              onCut={(entries, dir) => setClip({ op: 'cut', side: 'right', base: dir, sep: LOCAL_SEP, entries })}
              onCopy={(entries, dir) => setClip({ op: 'copy', side: 'right', base: dir, sep: LOCAL_SEP, entries })}
              onPaste={(dir) => void doPaste('right', dir)}
              canPaste={!!clip && !busy}
              cutMarks={clip?.op === 'cut' && clip.side === 'right' ? { dir: clip.base, names: clip.entries.map((e) => e.name) } : null}
            />
          )
        )}
      </div>

      {/* Transfer status bar */}
      <div
        style={{
          minHeight: 26,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 10px',
          borderTop: '1px solid var(--border-2)',
          background: 'var(--bg-panel)',
          font: '400 10.5px var(--font-mono)',
          color: 'var(--text-muted)',
        }}
      >
        {myEdits.length > 0 && (
          <button
            className="fb-sync-btn"
            style={{
              flex: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              ...(editErr ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : {}),
            }}
            onClick={() => setEditsOpen((v) => !v)}
          >
            <IconPencil size={12} />
            {t('fb.editingN', { n: myEdits.length })}
          </button>
        )}
        {hasRemote && conn === 'ready' && !busy && !planning && (
          <button
            className="fb-sync-btn"
            style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 5 }}
            onClick={onBiSyncClick}
          >
            <IconSwap size={13} />
            {t('sync.biBtn')}
          </button>
        )}
        {busy ? (
          <>
            <span style={{ color: paused ? 'var(--warn)' : 'var(--accent)', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {paused && (
                <>
                  <IconPause size={11} /> {t('fb.paused')} ·
                </>
              )}
              {batch?.verb ?? t('fb.transferring')} {batch ? `${batch.done}/${batch.total}` : ''}
              {progress ? ` · ${progress.name}` : '…'}
            </span>
            {progress && (
              <>
                <div
                  style={{
                    flex: 1,
                    maxWidth: 220,
                    height: 5,
                    background: 'var(--border-2)',
                    borderRadius: 3,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${progress.total ? Math.min(100, (progress.done / progress.total) * 100) : 0}%`,
                      height: '100%',
                      background: 'var(--accent)',
                      transition: 'width 0.1s',
                    }}
                  />
                </div>
                <span style={{ whiteSpace: 'nowrap' }}>
                  {fmtBytes(progress.done)} / {fmtBytes(progress.total)}
                </span>
              </>
            )}
            <button
              className="fb-cancel"
              style={{ marginLeft: 'auto', borderColor: 'var(--warn)', color: 'var(--warn)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
              onClick={() => {
                pausedRef.current = !pausedRef.current;
                setPaused(pausedRef.current);
              }}
            >
              {paused ? <IconPlay size={12} /> : <IconPause size={12} />}
              {paused ? t('fb.resumeBtn') : t('fb.pauseBtn')}
            </button>
            <button
              className="fb-cancel"
              title={t('fb.cancelTip')}
              onClick={() => (cancelRef.current = true)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <IconClose size={12} />
              {t('fb.cancelBtn')}
            </button>
          </>
        ) : planning ? (
          <span style={{ color: 'var(--accent)' }}>{t('fb.analyzing')}</span>
        ) : biSummary ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: biSummary.cancelled ? 'var(--warn)' : 'var(--accent)' }}>
            {biSummary.cancelled ? t('fb.syncCancelled') : <IconCheck size={12} />}
            {t('sync.biDone', { up: biSummary.uploaded, down: biSummary.downloaded })}
            {biSummary.unchanged > 0 && ` · ${t('fb.syncKept', { n: biSummary.unchanged })}`}
            {biSummary.failed > 0 && ` · ${t('fb.errN', { n: biSummary.failed })}`}
          </span>
        ) : syncSummary ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: syncSummary.cancelled ? 'var(--warn)' : 'var(--accent)' }}>
            {syncSummary.cancelled ? t('fb.syncCancelled') : <IconCheck size={12} />}
            {syncSummary.cancelled ? '' : t('fb.syncDone')}
            {syncSummary.dir === 'up' ? t('fb.syncUploaded') : t('fb.syncDownloaded')} {syncSummary.uploaded}
            {syncSummary.deleted > 0 &&
              ` · ${t('fb.syncDeleted', { n: syncSummary.deleted, side: syncSummary.dir === 'up' ? t('fb.sideRemote') : t('fb.sideLocal') })}`}
            {syncSummary.unchanged > 0 && ` · ${t('fb.syncKept', { n: syncSummary.unchanged })}`}
            {syncSummary.failed > 0 && ` · ${t('fb.errN', { n: syncSummary.failed })}`}
          </span>
        ) : summary ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: summary.cancelled ? 'var(--warn)' : 'var(--accent)' }}>
            {summary.cancelled ? t('fb.cancelled') : <IconCheck size={12} />}
            {t('fb.transferredN', { verb: summary.verb, n: summary.transferred })}
            {summary.skipped > 0 && ` · ${t('fb.skippedN', { n: summary.skipped })}`}
            {summary.failed > 0 && ` · ${t('fb.errN', { n: summary.failed })}`}
          </span>
        ) : (
          <span>{hasRemote ? t('fb.idleRemote') : t('fb.idleLocal')}</span>
        )}
      </div>

      {conflict && <ConflictDialog name={conflict.name} onChoose={resolveConflict} />}

      {syncPlan && (
        <SyncConfirm
          info={syncPlan}
          onCancel={() => setSyncPlan(null)}
          onConfirm={() => void runSyncNow()}
        />
      )}

      {biPlan && (
        <BiSyncConfirm
          info={biPlan}
          onCancel={() => setBiPlan(null)}
          onConfirm={() => void runBiSyncNow()}
        />
      )}

      {editsOpen && (
        <div
          onMouseDown={() => setEditsOpen(false)}
          style={{ position: 'absolute', inset: 0, zIndex: 46 }}
        >
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              left: 10,
              bottom: 32,
              width: 380,
              maxHeight: 260,
              overflow: 'auto',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-3)',
              borderRadius: 10,
              boxShadow: '0 16px 40px rgba(0,0,0,0.55)',
              padding: 8,
            }}
          >
            {myEdits.map((ed) => (
              <div key={ed.editId} style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ font: '600 11.5px var(--font-ui)', color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={ed.remotePath}>
                    {ed.name}
                  </span>
                  <span style={{ font: '400 10px var(--font-mono)', color: ed.error ? 'var(--danger)' : 'var(--text-muted)' }}>
                    {ed.uploading
                      ? t('fb.editUploading')
                      : ed.error
                        ? ed.error
                        : ed.lastUpload
                          ? t('fb.editUploaded', { time: new Date(ed.lastUpload).toLocaleTimeString() })
                          : t('fb.editNever')}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  <button className="ghost-btn" style={{ fontSize: 10.5 }} onClick={() => void uploadNow(ed.editId)}>
                    {t('fb.editReupload')}
                  </button>
                  <button className="ghost-btn" style={{ fontSize: 10.5 }} onClick={() => void redownload(ed.editId)}>
                    {t('fb.editRedownload')}
                  </button>
                  <button className="ghost-btn" style={{ fontSize: 10.5, color: 'var(--danger)' }} onClick={() => stopEdit(ed.editId)}>
                    {t('fb.editStop')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BiSyncConfirm({
  info,
  onCancel,
  onConfirm,
}: {
  info: { plan: BiSyncPlan; local: string; remote: string };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const { plan, local, remote } = info;
  const nothing = plan.uploads.length === 0 && plan.downloads.length === 0;
  return (
    <div
      onMouseDown={onCancel}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(5,7,10,0.55)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 46,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 430,
          background: 'var(--surface-2)',
          border: '1px solid var(--border-3)',
          borderRadius: 12,
          boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
          padding: 20,
        }}
      >
        <div style={{ font: '600 14px var(--font-ui)', color: 'var(--text)', marginBottom: 10 }}>
          {t('sync.biTitle')}
        </div>
        <div style={{ font: '400 11px var(--font-mono)', color: 'var(--text-2)', marginBottom: 14, lineHeight: 1.6, wordBreak: 'break-all' }}>
          <div>
            <span style={{ color: 'var(--sh-ps)' }}>Local:</span> {local}
          </div>
          <div>
            <span style={{ color: 'var(--accent)' }}>Remote:</span> {remote}
          </div>
        </div>
        {nothing ? (
          <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)', marginBottom: 16 }}>
            {t('sync.nothing')}
          </div>
        ) : (
          <ul style={{ margin: '0 0 16px', paddingLeft: 18, font: '400 12px var(--font-ui)', color: 'var(--text-2)', lineHeight: 1.6 }}>
            {plan.uploads.length > 0 && (
              <li style={{ color: 'var(--sh-ps)' }}>{t('sync.biUp', { n: plan.uploads.length })}</li>
            )}
            {plan.downloads.length > 0 && (
              <li style={{ color: 'var(--accent)' }}>{t('sync.biDown', { n: plan.downloads.length })}</li>
            )}
            <li style={{ color: 'var(--text-muted)' }}>{t('sync.willKeep', { n: plan.unchanged })}</li>
          </ul>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="ghost-btn" style={{ flex: 1, height: 36, justifyContent: 'center' }} onClick={onCancel}>
            {nothing ? t('sync.close') : t('common.cancel')}
          </button>
          {!nothing && (
            <button className="accent-btn" style={{ flex: 1, height: 36, justifyContent: 'center' }} onClick={onConfirm}>
              {t('sync.run')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SyncConfirm({
  info,
  onCancel,
  onConfirm,
}: {
  info: { plan: SyncPlan; src: string; dst: string; dir: SyncDir };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const { plan, src, dst, dir } = info;
  const nothing = plan.uploads.length === 0 && plan.extrasCount === 0;
  // Source/target labels + colours follow the direction (local = blue, remote = green).
  const srcIsLocal = dir === 'up';
  const srcLabel = srcIsLocal ? t('sync.srcLocal') : t('sync.srcRemote');
  const dstLabel = srcIsLocal ? t('sync.dstRemote') : t('sync.dstLocal');
  const srcColor = srcIsLocal ? 'var(--sh-ps)' : 'var(--accent)';
  const dstColor = srcIsLocal ? 'var(--accent)' : 'var(--sh-ps)';
  const transferVerb = srcIsLocal ? t('fb.verbUpload') : t('fb.verbDownload');
  return (
    <div
      onMouseDown={onCancel}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(5,7,10,0.55)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 46,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 420,
          background: 'var(--surface-2)',
          border: '1px solid var(--border-3)',
          borderRadius: 12,
          boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
          padding: 20,
        }}
      >
        <div style={{ font: '600 14px var(--font-ui)', color: 'var(--text)', marginBottom: 10 }}>
          {t('sync.title')}
        </div>
        <div
          style={{
            font: '400 11px var(--font-mono)',
            color: 'var(--text-2)',
            marginBottom: 14,
            lineHeight: 1.6,
            wordBreak: 'break-all',
          }}
        >
          <div>
            <span style={{ color: srcColor }}>{srcLabel}:</span> {src}
          </div>
          <div>
            <span style={{ color: dstColor }}>{dstLabel}:</span> {dst}
          </div>
        </div>
        {nothing ? (
          <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)', marginBottom: 16 }}>
            {t('sync.nothing')}
          </div>
        ) : (
          <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)', marginBottom: 16, lineHeight: 1.6 }}>
            {t('sync.willDo')}
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              <li>{t('sync.willUpload', { verb: transferVerb, n: plan.uploads.length })}</li>
              {plan.extrasCount > 0 && (
                <li style={{ color: 'var(--danger)' }}>
                  {t('sync.willDelete', { n: plan.extrasCount, side: srcIsLocal ? t('fb.sideRemote') : t('fb.sideLocal') })}
                </li>
              )}
              <li style={{ color: 'var(--text-muted)' }}>{t('sync.willKeep', { n: plan.unchanged })}</li>
            </ul>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="ghost-btn" style={{ flex: 1, height: 36, justifyContent: 'center' }} onClick={onCancel}>
            {nothing ? t('sync.close') : t('common.cancel')}
          </button>
          {!nothing && (
            <button
              className="accent-btn"
              style={{ flex: 1, height: 36, justifyContent: 'center' }}
              onClick={onConfirm}
            >
              {t('sync.run')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Uniform height + centering for every button in the conflict dialog.
const CONFLICT_BTN: CSSProperties = {
  flex: 1,
  height: 36,
  padding: '0 12px',
  justifyContent: 'center',
};

function ConflictDialog({
  name,
  onChoose,
}: {
  name: string;
  onChoose: (a: ConflictAction) => void;
}) {
  const t = useT();
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(5,7,10,0.55)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 40,
      }}
    >
      <div
        style={{
          width: 380,
          background: 'var(--surface-2)',
          border: '1px solid var(--border-3)',
          borderRadius: 12,
          boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
          padding: 20,
        }}
      >
        <div style={{ font: '600 14px var(--font-ui)', color: 'var(--text)', marginBottom: 6 }}>
          {t('conflict.title')}
        </div>
        <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)', marginBottom: 16, lineHeight: 1.5 }}>
          {t('conflict.msg', { name })}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="accent-btn" style={CONFLICT_BTN} onClick={() => onChoose('overwrite')}>
              {t('conflict.overwrite')}
            </button>
            <button className="accent-btn" style={CONFLICT_BTN} onClick={() => onChoose('overwrite-all')}>
              {t('conflict.overwriteAll')}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="ghost-btn" style={CONFLICT_BTN} onClick={() => onChoose('skip')}>
              {t('conflict.skip')}
            </button>
            <button className="ghost-btn" style={CONFLICT_BTN} onClick={() => onChoose('skip-all')}>
              {t('conflict.skipAll')}
            </button>
          </div>
          <button
            className="ghost-btn"
            // Standalone in a column: flex:1 would stretch its HEIGHT (main axis),
            // making it taller than the paired rows — pin the width instead.
            style={{ ...CONFLICT_BTN, flex: 'none', width: '100%', color: 'var(--danger)' }}
            onClick={() => onChoose('cancel')}
          >
            {t('conflict.cancelAll')}
          </button>
        </div>
      </div>
    </div>
  );
}

function fmtBytes(b: number): string {
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}
