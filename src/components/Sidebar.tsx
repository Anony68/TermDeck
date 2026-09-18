import { useState } from 'react';
import { useStore, termId } from '../state/store';
import { PaneBadge } from './ShellBadge';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { IconPlus, IconSearch, IconSettings } from './icons';
import { useT } from '../i18n';
import type { Host } from '../types';

/** Connection dot for a host, from its terminal session status. */
function hostDotColor(status: string | undefined, ssh: { state: string } | undefined): string {
  if (!status || status === 'exited') return 'var(--text-muted)';
  if (ssh?.state === 'connected') return 'var(--accent, #2dd4a7)';
  if (ssh?.state === 'reconnecting') return 'var(--sh-wsl, #e5b34a)';
  return 'var(--sh-ps, #4aa3ff)';
}

function HostRow({ host }: { host: Host }) {
  const active = useStore((s) => s.activeHostId === host.id);
  const setActiveHost = useStore((s) => s.setActiveHost);
  const openEditHost = useStore((s) => s.openEditHost);
  const removeHost = useStore((s) => s.removeHost);
  const status = useStore((s) => s.runtime[termId(host.id)]?.status);
  const ssh = useStore((s) => s.sshStatus[termId(host.id)]);
  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const items: MenuItem[] = [
    { label: t('host.edit'), onClick: () => openEditHost(host.id) },
    { label: '', separator: true },
    {
      label: t('host.delete'),
      danger: true,
      onClick: () => {
        if (confirm(t('host.deleteConfirm', { name: host.name?.trim() || host.ssh.host }))) removeHost(host.id);
      },
    },
  ];

  return (
    <>
      <div
        onClick={() => setActiveHost(host.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '8px 8px',
          margin: '0 8px 3px',
          borderRadius: 7,
          cursor: 'pointer',
          background: active ? 'color-mix(in srgb, var(--accent, #2dd4a7) 12%, transparent)' : 'transparent',
          border: '1px solid ' + (active ? 'color-mix(in srgb, var(--accent, #2dd4a7) 40%, transparent)' : 'transparent'),
        }}
      >
        <PaneBadge kind="ssh" size={22} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', flex: 'none', background: hostDotColor(status, ssh) }} />
            <span style={{ font: '600 12px var(--font-ui)', color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {host.name?.trim() || `${host.ssh.user}@${host.ssh.host}`}
            </span>
          </div>
          <div style={{ font: '400 10px var(--font-mono)', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {host.ssh.user}@{host.ssh.host}:{host.ssh.port}
          </div>
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={items} />}
    </>
  );
}

export function Sidebar() {
  const hosts = useStore((s) => s.hosts);
  const openAddHost = useStore((s) => s.openAddHost);
  const openSettings = useStore((s) => s.openSettings);
  const t = useT();
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const filtered = q
    ? hosts.filter(
        (h) =>
          h.name.toLowerCase().includes(q) ||
          h.ssh.host.toLowerCase().includes(q) ||
          h.ssh.user.toLowerCase().includes(q)
      )
    : hosts;

  return (
    <div
      style={{
        width: 250,
        flex: 'none',
        background: 'var(--bg-panel)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div style={{ padding: '12px 12px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ font: '600 10.5px var(--font-ui)', color: 'var(--text-muted)', letterSpacing: '0.08em', flex: 1 }}>
          {t('sidebar.title')}
        </span>
        <span className="icon-btn" title={t('toolbar.settings')} onClick={() => openSettings()}>
          <IconSettings size={15} />
        </span>
      </div>
      <div style={{ padding: '0 12px 8px' }}>
        <button className="accent-btn" style={{ width: '100%', justifyContent: 'center', gap: 5 }} onClick={openAddHost}>
          <IconPlus size={15} /> {t('host.add')}
        </button>
      </div>
      <div style={{ margin: '2px 12px 8px', display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ display: 'inline-flex', color: 'var(--text-muted)' }}>
          <IconSearch size={14} />
        </span>
        <input
          className="field"
          placeholder={t('sidebar.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ padding: '6px 8px', fontSize: 11.5 }}
        />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', paddingTop: 2 }}>
        {filtered.length === 0 ? (
          <div style={{ padding: '20px 16px', textAlign: 'center', color: 'var(--text-muted)', font: '400 11.5px var(--font-ui)' }}>
            {hosts.length === 0 ? t('sidebar.empty') : t('sidebar.noMatch')}
          </div>
        ) : (
          filtered.map((h) => <HostRow key={h.id} host={h} />)
        )}
      </div>
    </div>
  );
}
