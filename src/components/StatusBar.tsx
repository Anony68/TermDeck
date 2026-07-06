import { useState } from 'react';
import { useStore, activeTabSelector, displayItems } from '../state/store';
import { LAYOUTS, fitLayout } from '../layouts';
import { writeSession } from '../ipc/session';
import { useT } from '../i18n';

function fmtTime(ms: number | null): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export function StatusBar() {
  const tab = useStore(activeTabSelector);
  const panes = useStore((s) => s.panes);
  const runtime = useStore((s) => s.runtime);
  const savedAt = useStore((s) => s.savedAt);
  const claudeSessions = useStore((s) => s.claudeSessions);
  const stats = useStore((s) => s.stats);
  const t = useT();
  const [broadcast, setBroadcast] = useState<string | null>(null);
  if (!tab) return null;

  // A4: aggregate Claude activity across all panes running Claude.
  const claudeList = Object.values(claudeSessions).filter((c) => c.found);
  const claudeCtx = claudeList.reduce((sum, c) => sum + (c.contextTokens || 0), 0);
  const claudePanes = panes.filter((p) => stats[p.id]?.claude);

  // A6: broadcast a prompt to every Claude pane (type + Enter after a beat).
  const sendBroadcast = () => {
    const text = (broadcast ?? '').trim();
    if (!text) return setBroadcast(null);
    for (const p of claudePanes) {
      writeSession(p, text);
      window.setTimeout(() => writeSession(p, '\r'), 180);
    }
    setBroadcast(null);
  };

  const items = displayItems(tab, panes);
  const shown = items.map((it) => panes.find((p) => p.id === it.paneId)).filter(Boolean) as typeof panes;
  const cmdCount = items.length;
  const running = shown.filter((p) => (runtime[p.id]?.status ?? 'running') === 'running').length;
  const label = LAYOUTS[fitLayout(items.length, tab.layout)].label;

  return (
    <>
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
      {claudeList.length > 0 && (
        <span
          style={{ color: '#d97757', cursor: 'pointer' }}
          title={t('status.broadcastTip')}
          onClick={() => setBroadcast('')}
        >
          ✳ {t('status.claudeAgg', { n: claudeList.length, ctx: fmtK(claudeCtx) })} ⤳
        </span>
      )}
      <span style={{ flex: 1 }} />
      <span>{t('status.layout', { label })}</span>
      <span style={{ color: 'var(--accent)' }}>
        ● {savedAt ? t('status.saved', { time: fmtTime(savedAt) }) : t('status.autosave')}
      </span>
    </div>

    {broadcast !== null && (
      <div
        onMouseDown={() => setBroadcast(null)}
        style={{ position: 'fixed', inset: 0, background: 'rgba(5,7,10,0.55)', display: 'grid', placeItems: 'center', zIndex: 60 }}
      >
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            width: 460,
            background: 'var(--surface-2)',
            border: '1px solid var(--border-3)',
            borderRadius: 12,
            boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
            padding: 20,
          }}
        >
          <div style={{ font: '600 14px var(--font-ui)', color: '#d97757', marginBottom: 12 }}>
            ✳ {t('status.broadcastTitle')}
          </div>
          <textarea
            autoFocus
            className="field"
            placeholder={t('status.broadcastPlaceholder', { n: claudePanes.length })}
            value={broadcast}
            onChange={(e) => setBroadcast(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendBroadcast();
              if (e.key === 'Escape') setBroadcast(null);
            }}
            style={{ width: '100%', minHeight: 90, resize: 'vertical', font: '400 12.5px var(--font-ui)' }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
            <button className="ghost-btn" style={{ padding: '8px 16px' }} onClick={() => setBroadcast(null)}>
              {t('common.cancel')}
            </button>
            <button className="accent-btn" style={{ padding: '8px 16px' }} onClick={sendBroadcast}>
              {t('status.broadcastSend', { n: claudePanes.length })}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
