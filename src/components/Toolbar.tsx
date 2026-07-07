import { useStore, activeTabSelector } from '../state/store';
import { LAYOUT_ORDER } from '../layouts';
import { PresetIcon } from './PresetIcon';
import { useT } from '../i18n';

export function Toolbar() {
  const tab = useStore(activeTabSelector);
  const setLayout = useStore((s) => s.setLayout);
  const openSettings = useStore((s) => s.openSettings);
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
        style={{ width: 28, height: 28, fontSize: 14 }}
      >
        ☰
      </div>
      <span
        style={{
          font: '600 10.5px var(--font-ui)',
          color: 'var(--text-muted)',
          letterSpacing: '0.08em',
        }}
      >
        {t('toolbar.layout')}
      </span>
      <div
        style={{
          display: 'flex',
          gap: 4,
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-2)',
          borderRadius: 7,
          padding: 4,
        }}
      >
        {LAYOUT_ORDER.map((id) => (
          <div
            key={id}
            className={`preset-btn${tab?.layout === id ? ' active' : ''}`}
            title={id}
            onClick={() => setLayout(id)}
          >
            <PresetIcon preset={id} active={tab?.layout === id} />
          </div>
        ))}
      </div>
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
        style={{ width: 38, height: 38, fontSize: 20 }}
      >
        ⚙
      </div>
    </div>
  );
}
