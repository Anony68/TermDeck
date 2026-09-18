import { useStore } from '../state/store';
import { IconSidebar, IconSettings, IconPlus } from './icons';
import { useT } from '../i18n';

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
        gap: 14,
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

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          font: '400 11.5px var(--font-ui)',
          color: 'var(--text-muted)',
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)' }} />
        {t('toolbar.autoSaved')}
      </div>

      <div style={{ flex: 1 }} />
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
