import { useStore, activeTabSelector, displayItems } from '../state/store';
import { LAYOUTS, fitLayout } from '../layouts';

function fmtTime(ms: number | null): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function StatusBar() {
  const tab = useStore(activeTabSelector);
  const panes = useStore((s) => s.panes);
  const runtime = useStore((s) => s.runtime);
  const savedAt = useStore((s) => s.savedAt);
  if (!tab) return null;

  const items = displayItems(tab, panes);
  const shown = items.map((it) => panes.find((p) => p.id === it.paneId)).filter(Boolean) as typeof panes;
  const cmdCount = items.length;
  const running = shown.filter((p) => (runtime[p.id]?.status ?? 'running') === 'running').length;
  const label = LAYOUTS[fitLayout(items.length, tab.layout)].label;

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
      <span>tab: {tab.name}</span>
      <span>
        {cmdCount} terminal · {running} đang chạy
      </span>
      <span style={{ flex: 1 }} />
      <span>bố cục {label}</span>
      <span style={{ color: 'var(--accent)' }}>
        ● {savedAt ? `phiên đã lưu ${fmtTime(savedAt)}` : 'tự động lưu'}
      </span>
    </div>
  );
}
