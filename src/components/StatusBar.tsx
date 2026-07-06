import { useStore, activeTabSelector, displayItems } from '../state/store';
import { LAYOUTS, fitLayout } from '../layouts';
import { useT } from '../i18n';

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
  const t = useT();
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
      <span>{t('status.tab', { name: tab.name })}</span>
      <span>{t('status.counts', { count: cmdCount, running })}</span>
      <span style={{ flex: 1 }} />
      <span>{t('status.layout', { label })}</span>
      <span style={{ color: 'var(--accent)' }}>
        ● {savedAt ? t('status.saved', { time: fmtTime(savedAt) }) : t('status.autosave')}
      </span>
    </div>
  );
}
