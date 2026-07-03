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
      alert(`Lỗi truyền file: ${e}`);
    } finally {
      setBusy(false);
      setBatch(null);
      setProgress(null);
      setLeftKey((k) => k + 1);
      setRightKey((k) => k + 1);
    }
  };

  const onUpload = (entries: FileEntry[], fromLocal: string) =>
    void runBatch(entries, fromLocal, remoteCwd.current, uploadOps, 'Tải lên');
  const onDownload = (entries: FileEntry[], fromRemote: string) =>
    void runBatch(entries, fromRemote, localCwd.current, downloadOps, 'Tải về');

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
      alert(`Lỗi phân tích đồng bộ: ${e}`);
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
    setBatch({ done: 0, total: plan.uploads.length, verb: 'Đồng bộ' });
    try {
      const result = await runSync(src, dst, plan, ops, {
        onProgress: (done, total) => setBatch({ done, total, verb: 'Đồng bộ' }),
        shouldCancel: () => cancelRef.current,
      });
      setSyncSummary({ ...result, dir });
    } catch (e) {
      alert(`Lỗi đồng bộ: ${e}`);
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
        Trình quản lý file chỉ hoạt động trong ứng dụng (Tauri).
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
            title="MÁY CỤC BỘ (LOCAL)"
            backend={localBackend}
            initialPath={initialLocal}
            accent="var(--sh-ps)"
            transferLabel={hasRemote ? 'Tải lên ▶' : 'Sao chép ▶'}
            refreshKey={leftKey}
            onPathChange={setLocalCwd}
            onTransfer={(entries, from) =>
              hasRemote ? onUpload(entries, from) : alert('Chưa cấu hình SSH cho pane này.')
            }
            syncLabel={planning ? '⟳ …' : '⟳ Đồng bộ ▶'}
            onSync={hasRemote && conn === 'ready' && !busy ? () => onSyncClick('up') : undefined}
          />
        )}
        <div style={{ width: 1, background: 'var(--border-3)' }} />
        {hasRemote ? (
          conn === 'ready' ? (
            <FilePanel
              title={`REMOTE — ${pane.ssh?.user}@${pane.ssh?.host}`}
              backend={remoteBackend}
              initialPath={pane.browserRemotePath ?? pane.ssh?.remotePath ?? '/'}
              accent="var(--accent)"
              transferLabel="◀ Tải xuống"
              refreshKey={rightKey}
              onPathChange={setRemoteCwd}
              onTransfer={(entries, from) => onDownload(entries, from)}
              syncLabel={planning ? '◀ …' : '◀ Đồng bộ'}
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
                  {conn === 'connecting' ? 'Đang kết nối SFTP…' : 'Không kết nối được SFTP'}
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
              title="MÁY CỤC BỘ (LOCAL) — 2"
              backend={localBackend}
              initialPath={pane.browserRemotePath ?? initialLocal}
              accent="var(--sh-ps)"
              transferLabel="◀ Sao chép"
              refreshKey={rightKey}
              onPathChange={setRemoteCwd}
              onTransfer={() => alert('Chưa cấu hình SSH — không có đích remote.')}
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
              {batch?.verb ?? 'Đang truyền'} {batch ? `${batch.done}/${batch.total}` : ''}
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
              title="Dừng truyền sau tệp hiện tại"
              onClick={() => (cancelRef.current = true)}
            >
              ✕ Hủy
            </button>
          </>
        ) : planning ? (
          <span style={{ color: 'var(--accent)' }}>Đang phân tích khác biệt để đồng bộ…</span>
        ) : syncSummary ? (
          <span style={{ color: syncSummary.cancelled ? 'var(--warn)' : 'var(--accent)' }}>
            {syncSummary.cancelled ? '■ Đồng bộ đã hủy — ' : '✓ Đồng bộ — '}
            {syncSummary.dir === 'up' ? 'tải lên' : 'tải về'} {syncSummary.uploaded}
            {syncSummary.deleted > 0 &&
              ` · xóa ${syncSummary.deleted} (${syncSummary.dir === 'up' ? 'remote' : 'cục bộ'})`}
            {syncSummary.unchanged > 0 && ` · giữ nguyên ${syncSummary.unchanged}`}
            {syncSummary.failed > 0 && ` · lỗi ${syncSummary.failed}`}
          </span>
        ) : summary ? (
          <span style={{ color: summary.cancelled ? 'var(--warn)' : 'var(--accent)' }}>
            {summary.cancelled ? '■ Đã hủy — ' : '✓ '}
            {summary.verb} {summary.transferred} tệp
            {summary.skipped > 0 && ` · bỏ qua ${summary.skipped}`}
            {summary.failed > 0 && ` · lỗi ${summary.failed}`}
          </span>
        ) : (
          <span>
            {hasRemote
              ? 'Sẵn sàng — chọn tệp/thư mục rồi Tải lên/Tải xuống · SYNC để đồng bộ (chuột phải để có thêm lệnh)'
              : 'Chế độ 2 thư mục cục bộ'}
          </span>
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
  const { plan, src, dst, dir } = info;
  const nothing = plan.uploads.length === 0 && plan.extrasCount === 0;
  // Source/target labels + colours follow the direction (local = blue, remote = green).
  const srcIsLocal = dir === 'up';
  const srcLabel = srcIsLocal ? 'Cục bộ (nguồn)' : 'Remote (nguồn)';
  const dstLabel = srcIsLocal ? 'Remote (đích)' : 'Cục bộ (đích)';
  const srcColor = srcIsLocal ? 'var(--sh-ps)' : 'var(--accent)';
  const dstColor = srcIsLocal ? 'var(--accent)' : 'var(--sh-ps)';
  const transferVerb = srcIsLocal ? 'Tải lên' : 'Tải về';
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
          Đồng bộ thư mục (một chiều)
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
            Đích đã khớp với nguồn — không có gì để đồng bộ.
          </div>
        ) : (
          <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)', marginBottom: 16, lineHeight: 1.6 }}>
            Thao tác sẽ:
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              <li>
                {transferVerb} <b style={{ color: 'var(--text)' }}>{plan.uploads.length}</b> tệp mới/đã thay đổi
              </li>
              {plan.extrasCount > 0 && (
                <li style={{ color: 'var(--danger)' }}>
                  <b>XÓA {plan.extrasCount}</b> mục thừa ở {srcIsLocal ? 'remote' : 'cục bộ'} (đích) — không có trong nguồn
                </li>
              )}
              <li style={{ color: 'var(--text-muted)' }}>Giữ nguyên {plan.unchanged} tệp đã khớp</li>
            </ul>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="ghost-btn" style={{ flex: 1, height: 36, justifyContent: 'center' }} onClick={onCancel}>
            {nothing ? 'Đóng' : 'Hủy'}
          </button>
          {!nothing && (
            <button
              className="accent-btn"
              style={{ flex: 1, height: 36, justifyContent: 'center' }}
              onClick={onConfirm}
            >
              Đồng bộ ngay
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
          Tệp đã tồn tại
        </div>
        <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)', marginBottom: 16, lineHeight: 1.5 }}>
          Đích đến đã có{' '}
          <span style={{ color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{name}</span>. Bạn muốn làm gì?
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="accent-btn" style={CONFLICT_BTN} onClick={() => onChoose('overwrite')}>
              Ghi đè
            </button>
            <button className="accent-btn" style={CONFLICT_BTN} onClick={() => onChoose('overwrite-all')}>
              Ghi đè tất cả
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="ghost-btn" style={CONFLICT_BTN} onClick={() => onChoose('skip')}>
              Bỏ qua
            </button>
            <button className="ghost-btn" style={CONFLICT_BTN} onClick={() => onChoose('skip-all')}>
              Bỏ qua tất cả
            </button>
          </div>
          <button
            className="ghost-btn"
            style={{ ...CONFLICT_BTN, color: 'var(--danger)' }}
            onClick={() => onChoose('cancel')}
          >
            Hủy toàn bộ
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
