import { useEffect, useState } from 'react';
import { claudeSessions, type ClaudeSessionInfo } from '../ipc/claude';
import { IconClose, IconPlay } from './icons';
import { useT } from '../i18n';

function ago(unixSec: number): string {
  if (!unixSec) return '';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Browse a project's past Claude sessions and resume one via `claude -r <id>`. */
export function ClaudeSessionsDialog({
  cwd,
  onPick,
  onClose,
}: {
  cwd: string;
  onPick: (sessionId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [list, setList] = useState<ClaudeSessionInfo[] | null>(null);

  useEffect(() => {
    void claudeSessions(cwd).then(setList);
  }, [cwd]);

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(5,7,10,0.55)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 55,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxHeight: '76vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--surface-2)',
          border: '1px solid var(--border-3)',
          borderRadius: 12,
          boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', padding: '15px 18px 12px' }}>
          <span style={{ font: '600 14px var(--font-ui)', color: 'var(--text)', flex: 1 }}>
            {t('claude.sessionsTitle')}
          </span>
          <span className="icon-btn" onClick={onClose} style={{ width: 24, height: 24 }}>
            <IconClose size={15} />
          </span>
        </div>
        <div
          style={{
            font: '400 10.5px var(--font-mono)',
            color: 'var(--text-muted)',
            padding: '0 18px 10px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {cwd}
        </div>
        <div style={{ overflow: 'auto', padding: '0 10px 12px', minHeight: 0 }}>
          {list === null && (
            <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 12 }}>…</div>
          )}
          {list?.length === 0 && (
            <div style={{ padding: 16, color: 'var(--text-faint)', fontSize: 12 }}>
              {t('claude.sessionsEmpty')}
            </div>
          )}
          {list?.map((s) => (
            <div
              key={s.sessionId}
              className="side-item"
              style={{ cursor: 'pointer', alignItems: 'flex-start' }}
              title={t('claude.resumeThis')}
              onClick={() => onPick(s.sessionId)}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    font: '500 12.5px var(--font-ui)',
                    color: 'var(--text)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {s.title || s.sessionId.slice(0, 8)}
                </div>
                <div style={{ font: '400 10px var(--font-mono)', color: 'var(--text-muted)', marginTop: 2 }}>
                  {s.sessionId.slice(0, 8)} · {t('claude.sessionTurns', { n: s.turns })} · {ago(s.mtime)}
                </div>
              </div>
              <span style={{ display: 'inline-flex', color: '#d97757', marginTop: 2 }}>
                <IconPlay size={13} />
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
