import { useEffect, useState } from 'react';
import { useStore, activeTabSelector } from '../state/store';
import { LAYOUT_ORDER } from '../layouts';
import { PresetIcon } from './PresetIcon';
import { ClaudeIcon } from './ClaudeIcon';
import { CursorIcon } from './CursorIcon';
import { IconSidebar, IconSettings, IconRefresh } from './icons';
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
  const usageClaude = useStore((s) => s.settings.usageClaude);
  const usageCursor = useStore((s) => s.settings.usageCursor);
  const t = useT();
  const [claude, setClaude] = useState<ClaudeUsage | null>(null);
  const [cursor, setCursor] = useState<CursorUsage | null>(null);
  const [view, setView] = useState<UsageView>(
    () => (localStorage.getItem(USAGE_VIEW_KEY) === 'cursor' ? 'cursor' : 'claude')
  );

  useEffect(() => {
    let alive = true;
    // A provider toggled off in Settings is never polled (no token reads, no
    // network) and its stale data is dropped immediately.
    if (!usageClaude) setClaude(null);
    if (!usageCursor) setCursor(null);
    if (!usageClaude && !usageCursor) return;
    const load = () => {
      if (usageClaude) void claudeUsage().then((u) => alive && setClaude(u));
      if (usageCursor) void cursorUsage().then((u) => alive && setCursor(u));
    };
    load();
    const iv = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(iv);
    };
  }, [usageClaude, usageCursor]);

  // Show the widget if either provider has data. The toggle picks which to view;
  // the selected provider may be empty (shows a hint) so the user can still switch.
  if (!claude && !cursor) return null;
  const enabled: Record<UsageView, boolean> = { claude: usageClaude, cursor: usageCursor };
  const active: UsageView = enabled[view] ? view : view === 'claude' ? 'cursor' : 'claude';
  const select = (v: UsageView) => {
    setView(v);
    localStorage.setItem(USAGE_VIEW_KEY, v);
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

  let body: React.ReactNode;
  let tip: string;

  if (active === 'claude' && claude) {
    const p5 = Math.round(claude.fiveHour.utilization);
    const p7 = Math.round(claude.sevenDay.utilization);
    tip =
      `${t('toolbar.usageTitle')}\n` +
      `${t('toolbar.usageSession')}: ${p5}% — ${t('toolbar.usageResetAt', { t: fmtTime(claude.fiveHour.resetsAt) })}\n` +
      `${t('toolbar.usageWeek')}: ${p7}% — ${t('toolbar.usageResetAt', { t: fmtTime(claude.sevenDay.resetsAt) })}`;
    body = (
      <>
        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>5h</span>
        <UsageBar pct={p5} />
        <span style={{ color: usageColor(p5) }}>{p5}%</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--text-muted)', fontWeight: 400 }}>
          <IconRefresh size={11} /> {fmtTime(claude.fiveHour.resetsAt)}
        </span>
        <span style={{ width: 1, height: 12, background: 'var(--border-2)' }} />
        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>7d</span>
        <UsageBar pct={p7} />
        <span style={{ color: usageColor(p7) }}>{p7}%</span>
      </>
    );
  } else if (active === 'cursor' && cursor) {
    const u = cursor;
    const resetStr = u.resetsAt
      ? new Date(u.resetsAt).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' })
      : '—';
    const pct = Math.round(u.utilization);
    // Capitalised plan name ("ultra" → "Ultra").
    const planLabel = u.plan ? u.plan.charAt(0).toUpperCase() + u.plan.slice(1) : 'Cursor';
    tip =
      `${t('toolbar.cursorTitle')} — ${planLabel}\n` +
      (u.limit > 0 ? `${t('toolbar.cursorUsed', { n: u.used, m: u.limit })}\n` : '') +
      t('toolbar.usageResetAt', { t: resetStr });
    body = (
      <>
        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{planLabel}</span>
        {u.unlimited ? (
          <span style={{ color: 'var(--accent)' }}>∞</span>
        ) : (
          <>
            <UsageBar pct={pct} />
            <span style={{ color: usageColor(pct) }}>{pct}%</span>
          </>
        )}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--text-muted)', fontWeight: 400 }}>
          <IconRefresh size={11} /> {resetStr}
        </span>
      </>
    );
  } else {
    // Selected provider has no local data (not installed / not signed in).
    tip = active === 'claude' ? t('toolbar.usageTitle') : t('toolbar.cursorTitle');
    body = (
      <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{t('toolbar.usageNoData')}</span>
    );
  }

  // Toggle segment: a provider icon button; dims when it's not the active view.
  const seg = (v: UsageView, node: React.ReactNode, title: string) => (
    <span
      className="usage-seg"
      title={title}
      onClick={() => select(v)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 4px',
        borderRadius: 5,
        cursor: 'pointer',
        opacity: active === v ? 1 : 0.4,
        background: active === v ? 'var(--border-2)' : 'transparent',
      }}
    >
      {node}
    </span>
  );

  return (
    <div
      title={tip}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '4px 8px',
        background: 'var(--bg-panel)',
        border: '1px solid var(--border-2)',
        borderRadius: 7,
        font: '600 11px var(--font-ui)',
        color: 'var(--text-2)',
        whiteSpace: 'nowrap',
        userSelect: 'none',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
        {usageClaude && seg('claude', <ClaudeIcon size={12} />, 'Claude Code')}
        {usageCursor && seg('cursor', <CursorIcon size={13} />, 'Cursor')}
      </span>
      <span style={{ width: 1, height: 12, background: 'var(--border-2)' }} />
      {body}
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
        style={{ width: 28, height: 28 }}
      >
        <IconSidebar size={17} />
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
        <div style={{ width: 1, background: 'var(--border-2)', margin: '2px 1px' }} />
        <div
          className={`preset-btn${tab?.layout === 'auto' ? ' active' : ''}`}
          title={t('toolbar.layoutAuto')}
          onClick={() => setLayout('auto')}
        >
          <PresetIcon preset="auto" active={tab?.layout === 'auto'} />
        </div>
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
        style={{ width: 40, height: 40 }}
      >
        <IconSettings size={22} />
      </div>
    </div>
  );
}
