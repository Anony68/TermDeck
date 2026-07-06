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
  sftpConnect,
  sftpList,
  sftpMkdir,
  sftpRename,
  sftpRemove,
  sftpUpload,
  sftpDownload,
  onSftpProgress,
} from '../ipc/ssh';
import { FilePanel, type FsBackend } from './FilePanel';
import {
  runTransfer,
  type ConflictAction,
  type TransferOps,
  type TransferSummary,
} from './transfer';
import { planSync, runSync, type SyncOps, type SyncPlan, type SyncSummary } from './sync';
import { IS_TAURI } from '../ipc/env';
import { useT } from '../i18n';

type Conn = 'connecting' | 'ready' | 'error' | 'local-only';
/** Sync direction: 'up' = local ▶ remote, 'down' = remote ▶ local. */
type SyncDir = 'up' | 'down';

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
  const [localHome, setLocalHome] = useState<string | null>(null);
  const [leftKey, setLeftKey] = useState(0);
  const [rightKey, setRightKey] = useState(0);

  // Live current-dir of each side, so a transfer knows the opposite destination.
  const localCwd = useRef(pane.browserLocalPath ?? '');
  const remoteCwd = useRef(pane.browserRemotePath ?? pane.ssh?.remotePath ?? '/');
  // Resolver for the pending conflict prompt (set while the modal is open).
  const conflictResolve = useRef<((a: ConflictAction) => void) | null>(null);
  // Set true to abort the running transfer batch before the next file.
  const cancelRef = useRef(false);

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
        .then(() => alive && setConn('ready'))
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
    () => ({ list: fsList, mkdir: fsMkdir, rename: fsRename, remove: fsRemove, sep: '\\' }),
    []
  );
  const remoteBackend = useMemo<FsBackend>(
    () => ({
      list: (p) => sftpList(pane.id, p),
      mkdir: (p) => sftpMkdir(pane.id, p),
      rename: (f, t) => sftpRename(pane.id, f, t),
      remove: (p, d) => sftpRemove(pane.id, p, d),
      sep: '/',
    }),
    [pane.id]
  );

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
    srcSep: '\\',
    dstList: (d) => sftpList(pane.id, d),
    dstSep: '/',
    dstMkdir: (d) => sftpMkdir(pane.id, d),
    doTransfer: (s, d) => sftpUpload(pane.id, s, d),
  };
  const downloadOps: TransferOps = {
    srcList: (d) => sftpList(pane.id, d),
    srcSep: '/',
    dstList: fsList,
    dstSep: '\\',
    dstMkdir: fsMkdir,
    doTransfer: (s, d) => sftpDownload(pane.id, s, d),
  };

  const runBatch = async (
    entries: FileEntry[],
    fromDir: string,
    toDir: string,
    ops: TransferOps,
    verb: string
  ) => {
    setBusy(true);
    setSummary(null);
    cancelRef.current = false;
    setBatch({ done: 0, total: entries.length, verb });
    try {
      const result = await runTransfer(entries, fromDir, toDir, ops, {
        onConflict: askConflict,
        onProgress: (done, total) => setBatch({ done, total, verb }),
        shouldCancel: () => cancelRef.current,
      });
      setSummary({ ...result, verb });
    } catch (e) {
      alert(t('fb.transferErr', { err: String(e) }));
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

  // One-way mirror ops for each direction. 'up' = local ▶ remote (upload),
  // 'down' = remote ▶ local (download). Both delete extras on the target.
  const upSyncOps: SyncOps = {
    srcList: fsList,
    srcSep: '\\',
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
    dstSep: '\\',
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
  const runSyncNow = async () => {
    if (!syncPlan) return;
    const { plan, src, dst, ops, dir } = syncPlan;
    setSyncPlan(null);
    setBusy(true);
    cancelRef.current = false;
    setBatch({ done: 0, total: plan.uploads.length, verb: t('fb.verbSync') });
    try {
      const result = await runSync(src, dst, plan, ops, {
        onProgress: (done, total) => setBatch({ done, total, verb: t('fb.verbSync') }),
        shouldCancel: () => cancelRef.current,
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
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, position: 'relative' }}>
      <div style={{ flex: 1, display: 'flex', minHeight: 0, minWidth: 0 }}>
        {initialLocal !== null && (
          <FilePanel
            key={`local-${initialLocal}`}
            title={t('fb.local')}
            backend={localBackend}
            initialPath={initialLocal}
            accent="var(--sh-ps)"
            transferLabel={hasRemote ? t('fb.upload') : t('fb.copyRight')}
            refreshKey={leftKey}
            onPathChange={setLocalCwd}
            onTransfer={(entries, from) =>
              hasRemote ? onUpload(entries, from) : alert(t('fb.noSsh'))
            }
            syncLabel={planning ? t('fb.syncBusy') : t('fb.syncUp')}
            onSync={hasRemote && conn === 'ready' && !busy ? () => onSyncClick('up') : undefined}
          />
        )}
        <div style={{ width: 1, background: 'var(--border-3)' }} />
        {hasRemote ? (
          conn === 'ready' ? (
            <FilePanel
              title={t('fb.remote', { user: pane.ssh?.user ?? '', host: pane.ssh?.host ?? '' })}
              backend={remoteBackend}
              initialPath={pane.browserRemotePath ?? pane.ssh?.remotePath ?? '/'}
              accent="var(--accent)"
              transferLabel={t('fb.download')}
              refreshKey={rightKey}
              onPathChange={setRemoteCwd}
              onTransfer={(entries, from) => onDownload(entries, from)}
              syncLabel={planning ? t('fb.syncBusyDown') : t('fb.syncDown')}
              onSync={!busy ? () => onSyncClick('down') : undefined}
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
              refreshKey={rightKey}
              onPathChange={setRemoteCwd}
              onTransfer={() => alert(t('fb.noRemote'))}
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
        {busy ? (
          <>
            <span style={{ color: 'var(--accent)', whiteSpace: 'nowrap' }}>
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
              style={{ marginLeft: 'auto' }}
              title={t('fb.cancelTip')}
              onClick={() => (cancelRef.current = true)}
            >
              {t('fb.cancelBtn')}
            </button>
          </>
        ) : planning ? (
          <span style={{ color: 'var(--accent)' }}>{t('fb.analyzing')}</span>
        ) : syncSummary ? (
          <span style={{ color: syncSummary.cancelled ? 'var(--warn)' : 'var(--accent)' }}>
            {syncSummary.cancelled ? t('fb.syncCancelled') : t('fb.syncDone')}
            {syncSummary.dir === 'up' ? t('fb.syncUploaded') : t('fb.syncDownloaded')} {syncSummary.uploaded}
            {syncSummary.deleted > 0 &&
              ` · ${t('fb.syncDeleted', { n: syncSummary.deleted, side: syncSummary.dir === 'up' ? t('fb.sideRemote') : t('fb.sideLocal') })}`}
            {syncSummary.unchanged > 0 && ` · ${t('fb.syncKept', { n: syncSummary.unchanged })}`}
            {syncSummary.failed > 0 && ` · ${t('fb.errN', { n: syncSummary.failed })}`}
          </span>
        ) : summary ? (
          <span style={{ color: summary.cancelled ? 'var(--warn)' : 'var(--accent)' }}>
            {summary.cancelled ? t('fb.cancelled') : '✓ '}
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
            style={{ ...CONFLICT_BTN, color: 'var(--danger)' }}
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
