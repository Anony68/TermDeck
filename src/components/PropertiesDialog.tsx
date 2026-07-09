// Bitvise-style Properties dialog: metadata + (remote) an editable rwx grid.
import { useEffect, useState } from 'react';
import type { FileEntry, StatInfo } from '../ipc/ssh';
import type { FsBackend } from './FilePanel';
import { joinPath } from './pathUtils';
import { useT } from '../i18n';

function fmtBytesLong(b: number): string {
  const u = b >= 1073741824 ? [1073741824, 'GB'] : b >= 1048576 ? [1048576, 'MB'] : b >= 1024 ? [1024, 'KB'] : null;
  return u ? `${(b / (u[0] as number)).toFixed(1)} ${u[1]} (${b.toLocaleString()} B)` : `${b} B`;
}
function fmtTime(unixSec: number): string {
  if (!unixSec) return '—';
  return new Date(unixSec * 1000).toLocaleString();
}

export function PropertiesDialog({
  entry,
  dir,
  backend,
  onClose,
  onChanged,
}: {
  entry: FileEntry;
  dir: string;
  backend: FsBackend;
  onClose: () => void;
  /** Called after a chmod was applied so the panel can reload. */
  onChanged?: () => void;
}) {
  const t = useT();
  const full = joinPath(dir, entry.name, backend.sep);
  const [st, setSt] = useState<StatInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dirSize, setDirSize] = useState<number | null>(null);
  const [calcing, setCalcing] = useState(false);
  const [mode, setMode] = useState<number>(entry.mode & 0o777);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let alive = true;
    backend
      .stat?.(full)
      .then((s) => {
        if (!alive) return;
        setSt(s);
        setMode(s.mode & 0o777);
      })
      .catch((e) => alive && setErr(String(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full]);

  const calc = async () => {
    if (!backend.dirSize) return;
    setCalcing(true);
    try {
      setDirSize(await backend.dirSize(full));
    } catch {
      setDirSize(null);
    } finally {
      setCalcing(false);
    }
  };

  const applyMode = async () => {
    if (!backend.chmod) return;
    setApplying(true);
    try {
      await backend.chmod(full, mode);
      onChanged?.();
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setApplying(false);
    }
  };

  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div style={{ display: 'flex', gap: 10, padding: '3px 0' }}>
      <span style={{ width: 110, flex: 'none', font: '400 11px var(--font-ui)', color: 'var(--text-muted)' }}>{k}</span>
      <span className="mono" style={{ font: '400 11px var(--font-mono)', color: 'var(--text)', wordBreak: 'break-all' }}>{v}</span>
    </div>
  );

  const bit = (shift: number, m: number) => (mode >> shift) & m;
  const toggle = (shift: number, m: number) => setMode((v) => v ^ (m << shift));

  return (
    <div
      onMouseDown={onClose}
      style={{ position: 'absolute', inset: 0, background: 'rgba(5,7,10,0.55)', display: 'grid', placeItems: 'center', zIndex: 46 }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{ width: 400, maxHeight: '90%', overflow: 'auto', background: 'var(--surface-2)', border: '1px solid var(--border-3)', borderRadius: 12, boxShadow: '0 24px 60px rgba(0,0,0,0.6)', padding: 20 }}
      >
        <div style={{ font: '600 13px var(--font-ui)', color: 'var(--text)', marginBottom: 12 }}>
          {t('prop.title')} — {entry.name}
        </div>
        {err && <div style={{ color: 'var(--danger)', font: '400 11px var(--font-mono)', marginBottom: 8 }}>{err}</div>}

        <Row k={t('prop.path')} v={full} />
        <Row k={t('prop.type')} v={entry.isDir ? t('prop.typeDir') : t('prop.typeFile')} />
        <Row
          k={t('prop.size')}
          v={
            entry.isDir ? (
              dirSize !== null ? (
                fmtBytesLong(dirSize)
              ) : (
                <button className="ghost-btn" style={{ fontSize: 10.5 }} disabled={calcing || !backend.dirSize} onClick={() => void calc()}>
                  {calcing ? '…' : t('prop.calc')}
                </button>
              )
            ) : (
              fmtBytesLong(st?.size ?? entry.size)
            )
          }
        />
        <Row k={t('prop.modified')} v={fmtTime(st?.modified ?? entry.modified)} />
        {st && st.created > 0 && <Row k={t('prop.created')} v={fmtTime(st.created)} />}
        {st && st.accessed > 0 && <Row k={t('prop.accessed')} v={fmtTime(st.accessed)} />}
        {st?.isSymlink && <Row k={t('prop.symlink')} v={st.linkTarget || '—'} />}
        {/* local-only attributes */}
        {st && !backend.chmod && (
          <Row k={t('prop.attrs')} v={[st.readonly && t('prop.readonly'), st.hidden && t('prop.hidden')].filter(Boolean).join(', ') || '—'} />
        )}
        {/* remote-only: owner + editable permission grid */}
        {backend.chmod && st && (
          <>
            <Row k={t('prop.owner')} v={`uid ${st.uid} · gid ${st.gid}`} />
            <div style={{ marginTop: 12, borderTop: '1px solid var(--border-2)', paddingTop: 10 }}>
              <div style={{ font: '600 11.5px var(--font-ui)', color: 'var(--text)', marginBottom: 6 }}>
                {t('prop.perms')} — {(mode & 0o777).toString(8).padStart(3, '0')}
              </div>
              <table style={{ borderCollapse: 'collapse', font: '400 11px var(--font-ui)', color: 'var(--text-2)' }}>
                <thead>
                  <tr>
                    <th />
                    {['r', 'w', 'x'].map((h) => (
                      <th key={h} style={{ padding: '2px 10px', color: 'var(--text-muted)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: t('prop.permOwner'), shift: 6 },
                    { label: t('prop.permGroup'), shift: 3 },
                    { label: t('prop.permOther'), shift: 0 },
                  ].map((row) => (
                    <tr key={row.shift}>
                      <td style={{ padding: '2px 10px 2px 0' }}>{row.label}</td>
                      {[4, 2, 1].map((m) => (
                        <td key={m} style={{ textAlign: 'center' }}>
                          <input type="checkbox" checked={!!bit(row.shift, m)} onChange={() => toggle(row.shift, m)} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="ghost-btn" style={{ flex: 1, height: 36, justifyContent: 'center' }} onClick={onClose}>
            {t('common.cancel')}
          </button>
          {backend.chmod && (
            <button className="accent-btn" style={{ flex: 1, height: 36, justifyContent: 'center' }} disabled={applying} onClick={() => void applyMode()}>
              {t('prop.apply')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
