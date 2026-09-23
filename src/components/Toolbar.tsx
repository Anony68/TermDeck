import { useStore } from '../state/store';
import { IconSidebar, IconSettings, IconPlus, IconCloud } from './icons';
import { useT } from '../i18n';

/** Prominent account/sync button — opens the account dialog; shows sync state. */
function AccountChip() {
  const cloud = useStore((s) => s.cloud);
  const openAccount = useStore((s) => s.openAccount);
  const t = useT();
  const color = !cloud.signedIn
    ? 'var(--text-muted)'
    : cloud.unlocked
    ? 'var(--accent, #2dd4a7)'
    : 'var(--sh-wsl, #e5b34a)';
  const label = !cloud.signedIn
    ? t('account.signin')
    : cloud.unlocked
    ? (cloud.syncing ? t('account.status.syncing') : cloud.email || t('account.unlocked'))
    : t('account.unlock');
  return (
    <button
      onClick={openAccount}
      title={t('account.title')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        padding: '6px 12px',
        borderRadius: 7,
        border: `1px solid ${cloud.signedIn ? 'color-mix(in srgb, ' + color + ' 45%, transparent)' : 'var(--border-3)'}`,
        background: cloud.signedIn ? `color-mix(in srgb, ${color} 12%, transparent)` : 'transparent',
        color: cloud.signedIn ? 'var(--text)' : 'var(--text-2)',
        font: '600 11.5px var(--font-ui)',
        cursor: 'pointer',
        maxWidth: 220,
      }}
    >
      <span style={{ display: 'inline-flex', color }}><IconCloud size={14} /></span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  );
}

export function Toolbar() {
  const openSettings = useStore((s) => s.openSettings);
  const openAddHost = useStore((s) => s.openAddHost);
  const sidebarVisible = useStore((s) => s.settings.sidebarVisible);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const t = useT();

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        height: 44,
        background: 'var(--bg-card)',
        borderBottom: '1px solid var(--border)',
        padding: '0 14px',
        flex: 'none',
      }}
    >
      <div
        className="icon-btn"
        title={sidebarVisible ? t('toolbar.hideList') : t('toolbar.showList')}
        onClick={toggleSidebar}
        style={{ width: 28, height: 28 }}
      >
        <IconSidebar size={17} />
      </div>

      <button className="accent-btn" style={{ gap: 5 }} onClick={openAddHost}>
        <IconPlus size={15} /> {t('host.add')}
      </button>

      <div style={{ flex: 1 }} />
      <AccountChip />
      <div
        className="icon-btn"
        title={t('toolbar.settings')}
        onClick={() => openSettings()}
        style={{ width: 40, height: 40 }}
      >
        <IconSettings size={22} />
      </div>
    </div>
  );
}
