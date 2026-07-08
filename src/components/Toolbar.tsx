import { useEffect, useState } from 'react';
import { useStore, activeTabSelector } from '../state/store';
import { LAYOUT_ORDER } from '../layouts';
import { PresetIcon } from './PresetIcon';
import { ClaudeIcon } from './ClaudeIcon';
import { CursorIcon } from './CursorIcon';
import { claudeUsage, type ClaudeUsage } from '../ipc/claude';
import { cursorUsage, type CursorUsage } from '../ipc/cursor';
import { useT } from '../i18n';

const usageColor = (pct: number) =>
  pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warn)' : 'var(--accent)';

function UsageBar({ pct }: { pct: number }) {
  return (
    <span
      style={{
        width: 40,
        height: 5,
        borderRadius: 3,
        background: 'var(--border-2)',
        overflow: 'hidden',
        display: 'inline-block',
      }}
    >
      <span
        style={{
          display: 'block',
          height: '100%',
          width: `${Math.min(100, Math.max(0, pct))}%`,
          background: usageColor(pct),
          borderRadius: 3,
        }}
      />
    </span>
  );
}

type UsageView = 'claude' | 'cursor';
const USAGE_VIEW_KEY = 'termdeck.usageView';

/**
 * Plan usage for Claude Code / Cursor, one at a time — click to swap.
 * Sources with no local credentials return null and are skipped entirely;
 * with neither available the widget renders nothing.
 */
function UsageWidget() {
  const lang = useStore((s) => s.settings.language);
  const t = useT();
  const [claude, setClaude] = useState<ClaudeUsage | null>(null);
  const [cursor, setCursor] = useState<CursorUsage | null>(null);
  const [view, setView] = useState<UsageView>(
    () => (localStorage.getItem(USAGE_VIEW_KEY) === 'cursor' ? 'cursor' : 'claude')
  );

  useEffect(() => {
    let alive = true;
    const load = () => {
      void claudeUsage().then((u) => alive && setClaude(u));
      void cursorUsage().then((u) => alive && setCursor(u));
    };
    load();
    const iv = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(iv);
    };
  }, []);

  // Fall back to whichever source actually has data.
  const active: UsageView | null =
    view === 'cursor'
      ? cursor
        ? 'cursor'
        : claude
          ? 'claude'
          : null
      : claude
        ? 'claude'
        : cursor
          ? 'cursor'
          : null;
  if (!active) return null;

  const canSwap = !!claude && !!cursor;
  const swap = () => {
    if (!canSwap) return;
    const next: UsageView = active === 'claude' ? 'cursor' : 'claude';
    setView(next);
    localStorage.setItem(USAGE_VIEW_KEY, next);
  };

  const locale = lang === 'vi' ? 'vi-VN' : 'en-US';
  const fmtTime = (iso: string) => {
    if (!iso) return '—';
    const d = new Date(iso);
    const hm = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString()
      ? hm
      : `${d.toLocaleDateString(locale, { weekday: 'short' })} ${hm}`;
  };

  let icon: React.ReactNode;
  let body: React.ReactNode;
  let tip: string;

  if (active === 'claude' && claude) {
    const p5 = Math.round(claude.fiveHour.utilization);
    const p7 = Math.round(claude.sevenDay.utilization);
    icon = <ClaudeIcon size={12} title="Claude Code" />;
    tip =
      `${t('toolbar.usageTitle')}\n` +
      `${t('toolbar.usageSession')}: ${p5}% — ${t('toolbar.usageResetAt', { t: fmtTime(claude.fiveHour.resetsAt) })}\n` +
      `${t('toolbar.usageWeek')}: ${p7}% — ${t('toolbar.usageResetAt', { t: fmtTime(claude.sevenDay.resetsAt) })}`;
    body = (
      <>
        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>5h</span>
        <UsageBar pct={p5} />
        <span style={{ color: usageColor(p5) }}>{p5}%</span>
        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
          ↻ {fmtTime(claude.fiveHour.resetsAt)}
        </span>
        <span style={{ width: 1, height: 12, background: 'var(--border-2)' }} />
        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>7d</span>
        <UsageBar pct={p7} />
        <span style={{ color: usageColor(p7) }}>{p7}%</span>
      </>
    );
  } else {
    const u = cursor!;
    // The monthly window resets one month after startOfMonth.
    let resetStr = '—';
    if (u.startOfMonth) {
      const d = new Date(u.startOfMonth);
      d.setMonth(d.getMonth() + 1);
      resetStr = d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' });
    }
    const pct = Math.round(u.utilization);
    const hasQuota = u.maxRequests > 0;
    icon = <CursorIcon size={13} title="Cursor" />;
    tip =
      `${t('toolbar.cursorTitle')}\n` +
      `${t('toolbar.cursorReqs', { n: u.usedRequests, m: hasQuota ? u.maxRequests : '∞' })}\n` +
      t('toolbar.usageResetAt', { t: resetStr });
    body = (
      <>
        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>Cursor</span>
        {hasQuota ? (
          <>
            <UsageBar pct={pct} />
            <span style={{ color: usageColor(pct) }}>{pct}%</span>
          </>
        ) : (
          <span>{u.usedRequests} req</span>
        )}
        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>↻ {resetStr}</span>
      </>
    );
  }

  return (
    <div
      title={canSwap ? `${tip}\n\n${t('toolbar.usageSwap')}` : tip}
      onClick={swap}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '5px 10px',
        background: 'var(--bg-panel)',
        border: '1px solid var(--border-2)',
        borderRadius: 7,
        font: '600 11px var(--font-ui)',
        color: 'var(--text-2)',
        whiteSpace: 'nowrap',
        cursor: canSwap ? 'pointer' : 'default',
        userSelect: 'none',
      }}
    >
      {icon}
      {body}
      {canSwap && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>⇄</span>}
    </div>
  );
}

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
      <UsageWidget />
      <div
        className="icon-btn"
        title={t('toolbar.settings')}
        onClick={() => openSettings()}
        style={{ width: 40, height: 40, fontSize: 24 }}
      >
        ⚙
      </div>
    </div>
  );
}
