import { useStore, findHost, termId } from '../state/store';
import { useT } from '../i18n';

function fmtTime(ms: number | null): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function StatusBar() {
  const hostCount = useStore((s) => s.hosts.length);
  const activeHostId = useStore((s) => s.activeHostId);
  const host = useStore((s) => findHost(s, s.activeHostId));
  const status = useStore((s) => (activeHostId ? s.runtime[termId(activeHostId)]?.status : undefined));
  const ssh = useStore((s) => (activeHostId ? s.sshStatus[termId(activeHostId)] : undefined));
  const savedAt = useStore((s) => s.savedAt);
  const t = useT();

  let conn = '';
  if (host) {
    if (status === 'exited') conn = t('detail.disconnected');
    else if (ssh?.state === 'connected') conn = t('detail.connected');
    else if (ssh?.state === 'reconnecting') conn = t('detail.reconnecting', { n: ssh.attempt });
    else conn = t('detail.connecting');
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        height: 26,
        background: 'var(--bg-panel)',
        borderTop: '1px solid var(--border)',
        padding: '0 14px',
        font: '400 10.5px var(--font-mono)',
        color: 'var(--text-muted)',
        flex: 'none',
      }}
    >
      <span>{t('status.hosts', { count: hostCount })}</span>
      {host && (
        <span>
          {host.ssh.user}@{host.ssh.host} · {conn}
        </span>
      )}
      <span style={{ flex: 1 }} />
      <span style={{ color: 'var(--accent)' }}>
        ● {savedAt ? t('status.saved', { time: fmtTime(savedAt) }) : t('status.autosave')}
      </span>
    </div>
  );
}
