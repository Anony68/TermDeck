import { useState } from 'react';
import { useT } from '../i18n';
import { useStore } from '../state/store';
import { ClaudeIcon } from './ClaudeIcon';
import { IconClose } from './icons';
import { claudePlan, type ClaudeSession } from '../ipc/claude';
import { editOpen } from '../ipc/edit';
import { fsStat, fsHome } from '../ipc/ssh';
import { joinPath } from './pathUtils';

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

// Clickable tokens in the chat line: URLs, absolute paths (win/unix/~), relative
// paths, and bare file names with a 2–8 char extension — optionally with a
// trailing :line(:col). Order matters: URL → win-abs → multi-segment → bare name.
const LINK_RE =
  /(?:https?:\/\/[^\s"'<>()]+|[A-Za-z]:[\\/][^\s"'<>|*?]+|(?:~|\.{1,2})?[\\/]?[\w.@+-]+(?:[\\/][\w.@+-]+)+|[\w@+-]+(?:\.[\w+-]+)*\.[A-Za-z][A-Za-z0-9]{1,7})(?::\d+(?::\d+)?)?/g;

/** Open a matched token: URLs in the browser, existing files in the editor
 *  chosen in Settings (falls back to the OS default app). Silently does nothing
 *  when the token doesn't resolve to a real file — matches are heuristic. */
async function openToken(token: string, cwd: string): Promise<void> {
  const raw = token.replace(/[).,;:!?…]+$/, '');
  if (/^https?:\/\//i.test(raw)) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(raw);
    return;
  }
  let p = raw;
  const line = p.match(/:(\d+)(?::\d+)?$/);
  if (line) p = p.slice(0, line.index);
  p = p.replace(/^\.[\\/]/, '');
  const isAbs = /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]/.test(p);
  if (p.startsWith('~')) {
    const home = await fsHome();
    if (!home) return;
    p = home + p.slice(1);
  } else if (!isAbs) {
    if (!cwd) return;
    p = joinPath(cwd, p, /^[A-Za-z]:/.test(cwd) || cwd.includes('\\') ? '\\' : '/');
  }
  const st = await fsStat(p); // throws when missing → caller swallows
  if (st.isDir) return;
  const editor = useStore.getState().settings.defaultEditor;
  await editOpen(p, editor || undefined);
}

/** The last-assistant line with file paths / URLs rendered Ctrl+clickable. */
function LinkifiedMsg({ text, cwd }: { text: string; cwd: string }) {
  const t = useT();
  const parts: React.ReactNode[] = [];
  let i = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const start = m.index ?? 0;
    const tok = m[0];
    if (start > i) parts.push(text.slice(i, start));
    parts.push(
      <span
        key={start}
        className="cp-link"
        title={t('claude.openHint')}
        onClick={(e) => {
          if (!e.ctrlKey && !e.metaKey) return;
          e.stopPropagation();
          void openToken(tok, cwd).catch(() => {});
        }}
      >
        {tok}
      </span>
    );
    i = start + tok.length;
  }
  if (i < text.length) parts.push(text.slice(i));
  return (
    <div className="cp-msg" title={text}>
      {parts}
    </div>
  );
}

/**
 * Compact strip on a Claude pane showing the pane's REAL session state read from
 * `~/.claude/**.jsonl` — model, mode, context size, work/waiting status, and the
 * last assistant line. Sits between the terminal body and the stats footer.
 */
export function ClaudePanel({
  session,
  busy,
  cwd,
}: {
  session: ClaudeSession;
  busy: boolean;
  cwd: string;
}) {
  const t = useT();
  const [plan, setPlan] = useState<{ open: boolean; loading: boolean; text: string | null }>({
    open: false,
    loading: false,
    text: null,
  });
  const model = session.model.replace(/^claude-/, '');
  const waiting = session.waitingForInput && !busy;
  const statusText = busy
    ? t('claude.panelWorking')
    : waiting
      ? t('claude.panelWaiting')
      : t('claude.panelIdle');
  const statusColor = waiting ? 'var(--warn)' : busy ? '#d97757' : 'var(--text-muted)';

  const showPlan = () => {
    setPlan({ open: true, loading: true, text: null });
    void claudePlan(cwd).then((p) =>
      setPlan((cur) => (cur.open ? { open: true, loading: false, text: p.found ? p.plan : null } : cur))
    );
  };

  return (
    <>
      <div className={`claude-panel${waiting ? ' attn' : ''}`}>
        <div className="cp-row">
          <ClaudeIcon size={11} className={busy ? 'claude-pulse' : undefined} />
          {model && <span className="cp-badge">{model}</span>}
          {session.mode && session.mode !== 'normal' && (
            <span className="cp-badge alt">{session.mode}</span>
          )}
          {session.permissionMode && session.permissionMode !== 'default' && (
            <span className="cp-badge alt">{session.permissionMode}</span>
          )}
          {session.contextTokens > 0 && (
            <span className="cp-dim">ctx {fmtTokens(session.contextTokens)}</span>
          )}
          <button className="claude-chip" title={t('claude.viewPlanTip')} onClick={showPlan}>
            Plan
          </button>
          <span style={{ color: statusColor, fontWeight: 600, marginLeft: 'auto' }}>{statusText}</span>
        </div>
        {session.lastAssistant && <LinkifiedMsg text={session.lastAssistant} cwd={cwd} />}
      </div>

      {plan.open && (
        <div
          onMouseDown={(e) => {
            e.stopPropagation();
            setPlan({ open: false, loading: false, text: null });
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(5,7,10,0.55)',
            display: 'grid',
            placeItems: 'center',
            zIndex: 70,
          }}
        >
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              width: 'min(680px, 92vw)',
              maxHeight: 'min(560px, 84vh)',
              background: 'var(--bg-card)',
              border: '1px solid var(--border-2)',
              borderRadius: 12,
              boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                height: 38,
                background: 'var(--bg-panel)',
                borderBottom: '1px solid var(--border)',
                padding: '0 0 0 14px',
                flex: 'none',
              }}
            >
              <ClaudeIcon size={12} />
              <span style={{ font: '600 12.5px var(--font-ui)', color: 'var(--text)' }}>
                {t('claude.planTitle')}
              </span>
              <div style={{ flex: 1 }} />
              <div
                className="wc close"
                style={{ height: 38 }}
                onClick={() => setPlan({ open: false, loading: false, text: null })}
              >
                <IconClose size={15} />
              </div>
            </div>
            <div
              style={{
                padding: '14px 18px',
                overflow: 'auto',
                font: '400 11.5px var(--font-mono)',
                color: 'var(--text-2)',
                lineHeight: 1.55,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {plan.loading ? (
                <span style={{ color: 'var(--text-muted)' }}>{t('common.loading')}</span>
              ) : plan.text != null ? (
                plan.text
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>{t('claude.planEmpty')}</span>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
