import { useStore, activeTabSelector } from '../state/store';
import { LAYOUT_ORDER } from '../layouts';
import { PresetIcon } from './PresetIcon';

export function Toolbar() {
  const tab = useStore(activeTabSelector);
  const setLayout = useStore((s) => s.setLayout);
  const openSettings = useStore((s) => s.openSettings);
  const sidebarVisible = useStore((s) => s.settings.sidebarVisible);
  const toggleSidebar = useStore((s) => s.toggleSidebar);

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
        title={sidebarVisible ? 'Ẩn danh sách' : 'Hiện danh sách'}
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
        BỐ CỤC
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
        Phiên được lưu tự động
      </div>
      <div style={{ flex: 1 }} />
      <div
        className="icon-btn"
        title="Cài đặt"
        onClick={openSettings}
        style={{ width: 30, height: 30, fontSize: 14 }}
      >
        ⚙
      </div>
    </div>
  );
}
