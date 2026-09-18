import { useCallback, useEffect, useState } from 'react';
import { useStore, findPane, termId, sftpId } from '../state/store';
import { useSlots } from '../state/slots';
import { FileBrowser } from './FileBrowser';
import { PaneBadge } from './ShellBadge';
import { IconRefresh, IconPencil } from './icons';
import { useT } from '../i18n';

type DetailTab = 'terminal' | 'files';

/** Connection status pill for the SSH terminal session. */
function StatusPill({ hostId }: { hostId: string }) {
  const status = useStore((s) => s.runtime[termId(hostId)]?.status ?? 'running');
  const ssh = useStore((s) => s.sshStatus[termId(hostId)]);
  const t = useT();
  let color = 'var(--sh-ps, #4aa3ff)';
  let label = t('detail.connecting');
  if (status === 'exited') {
    color = 'var(--danger, #e5534b)';
    label = t('detail.disconnected');
  } else if (ssh?.state === 'connected') {
    color = 'var(--accent, #2dd4a7)';
    label = t('detail.connected');
  } else if (ssh?.state === 'reconnecting') {
    color = 'var(--sh-wsl, #e5b34a)';
    label = t('detail.reconnecting', { n: ssh.attempt });
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '400 11px var(--font-mono)', color }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
      {label}
    </span>
  );
}

/** Inner detail, remounted per host (key=hostId) so tab/state resets cleanly. */
function HostDetailInner({ hostId }: { hostId: string }) {
  const host = useStore((s) => s.hosts.find((h) => h.id === hostId))!;
  const ensureTerm = useStore((s) => s.ensureTerm);
  const ensureSftp = useStore((s) => s.ensureSftp);
  const restartPane = useStore((s) => s.restartPane);
  const openEditHost = useStore((s) => s.openEditHost);
  const setSlot = useSlots((s) => s.setSlot);
  const t = useT();

  const [tab, setTab] = useState<DetailTab>('terminal');
  const [sftpReady, setSftpReady] = useState(false);

  const tId = termId(hostId);
  const sId = sftpId(hostId);
  const termStatus = useStore((s) => s.runtime[tId]?.status ?? 'running');
  const termError = useStore((s) => s.runtime[tId]?.exitError);
  const sftpPane = useStore((s) => findPane(s, sId));

  // Selecting a host connects its SSH terminal (kept alive in the background).
  useEffect(() => {
    ensureTerm(hostId);
  }, [hostId, ensureTerm]);

  // Lazily open the SFTP session the first time the Files tab is shown.
  useEffect(() => {
    if (tab === 'files' && !sftpReady) void ensureSftp(hostId).then(() => setSftpReady(true));
  }, [tab, sftpReady, hostId, ensureSftp]);

  // Register the terminal slot only while the Terminal tab is visible; leaving it
  // parks the xterm off-screen (connection stays alive), returning re-attaches it.
  const slotRef = useCallback((el: HTMLDivElement | null) => setSlot(tId, el), [tId, setSlot]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          height: 46,
          flex: 'none',
          padding: '0 14px',
          borderBottom: '1px solid var(--border-2)',
          background: 'var(--bg-panel)',
        }}
      >
        <PaneBadge kind="ssh" size={24} />
        <div style={{ minWidth: 0 }}>
          <div style={{ font: '600 13px var(--font-ui)', color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {host.name?.trim() || `${host.ssh.user}@${host.ssh.host}`}
          </div>
          <div style={{ font: '400 11px var(--font-mono)', color: 'var(--text-muted)' }}>
            {host.ssh.user}@{host.ssh.host}:{host.ssh.port}
          </div>
        </div>
        <div style={{ marginLeft: 8 }}>
          <StatusPill hostId={hostId} />
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <span className="icon-btn" title={t('detail.reconnect')} onClick={() => restartPane(tId)}>
            <IconRefresh size={14} />
          </span>
          <span className="icon-btn" title={t('host.edit')} onClick={() => openEditHost(hostId)}>
            <IconPencil size={14} />
          </span>
        </div>
      </div>

      {/* Tab switch */}
      <div style={{ display: 'flex', gap: 4, padding: '6px 10px', flex: 'none', borderBottom: '1px solid var(--border-2)', background: 'var(--bg-panel-2, var(--bg-panel))' }}>
        {(['terminal', 'files'] as DetailTab[]).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              padding: '6px 12px',
              borderRadius: 7,
              border: '1px solid ' + (tab === k ? 'var(--accent, #2dd4a7)' : 'transparent'),
              background: tab === k ? 'color-mix(in srgb, var(--accent, #2dd4a7) 14%, transparent)' : 'transparent',
              color: tab === k ? 'var(--text)' : 'var(--text-muted)',
              font: '600 12px var(--font-ui)',
              cursor: 'pointer',
            }}
          >
            <PaneBadge kind={k === 'terminal' ? 'ssh' : 'browser'} size={16} />
            {k === 'terminal' ? t('detail.terminal') : t('detail.files')}
          </button>
        ))}
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
        {tab === 'terminal' ? (
          termStatus === 'exited' ? (
            <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, maxWidth: 420, padding: '0 16px' }}>
                <div style={{ font: '400 11.5px var(--font-mono)', color: 'var(--danger)', textAlign: 'center', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {termError || t('detail.disconnected')}
                </div>
                <button className="outline-accent-btn" onClick={() => restartPane(tId)}>
                  {t('detail.reconnect')}
                </button>
              </div>
            </div>
          ) : (
            <div ref={slotRef} style={{ position: 'absolute', inset: 0 }} />
          )
        ) : sftpReady && sftpPane ? (
          <FileBrowser pane={sftpPane} />
        ) : (
          <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: 'var(--text-muted)', font: '400 12px var(--font-ui)' }}>
            {t('common.loading')}
          </div>
        )}
      </div>
    </div>
  );
}

/** The main pane: shows the selected VPS, or an empty state prompting to add one. */
export function HostDetail() {
  const activeHostId = useStore((s) => s.activeHostId);
  const hasHost = useStore((s) => (activeHostId ? s.hosts.some((h) => h.id === activeHostId) : false));
  const openAddHost = useStore((s) => s.openAddHost);
  const t = useT();

  if (!activeHostId || !hasHost) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', minWidth: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, color: 'var(--text-muted)' }}>
          <div style={{ font: '600 15px var(--font-ui)', color: 'var(--text)' }}>{t('detail.emptyTitle')}</div>
          <div style={{ font: '400 12px var(--font-ui)' }}>{t('detail.emptyHint')}</div>
          <button className="outline-accent-btn" onClick={openAddHost}>
            {t('host.add')}
          </button>
        </div>
      </div>
    );
  }
  return <HostDetailInner key={activeHostId} hostId={activeHostId} />;
}
