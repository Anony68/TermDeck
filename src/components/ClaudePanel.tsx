import { useT } from '../i18n';
import { ClaudeIcon } from './ClaudeIcon';
import type { ClaudeSession } from '../ipc/claude';

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * Compact strip on a Claude pane showing the pane's REAL session state read from
 * `~/.claude/**.jsonl` — model, mode, context size, work/waiting status, and the
 * last assistant line. Sits between the terminal body and the stats footer.
 */
export function ClaudePanel({ session, busy }: { session: ClaudeSession; busy: boolean }) {
  const t = useT();
  const model = session.model.replace(/^claude-/, '');
  const waiting = session.waitingForInput && !busy;
  const statusText = busy
    ? t('claude.panelWorking')
    : waiting
      ? t('claude.panelWaiting')
      : t('claude.panelIdle');
  const statusColor = waiting ? 'var(--warn)' : busy ? '#d97757' : 'var(--text-muted)';

  return (
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
        <span style={{ color: statusColor, fontWeight: 600, marginLeft: 'auto' }}>{statusText}</span>
      </div>
      {session.lastAssistant && (
        <div className="cp-msg" title={session.lastAssistant}>
          {session.lastAssistant}
        </div>
      )}
    </div>
  );
}
