import { useState, useCallback, type MouseEvent } from 'react';
import type { Pane as PaneModel } from '../types';
import { useStore } from '../state/store';
import { useSlots } from '../state/slots';
import { SAVED_DND_MIME } from '../dnd';
import { useNow } from '../useNow';
import { PaneBadge } from './ShellBadge';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { ClaudeIcon } from './ClaudeIcon';
import { ClaudePanel } from './ClaudePanel';
import { ClaudeSessionsDialog } from './ClaudeSessionsDialog';
import { FileBrowser } from './FileBrowser';
import { IconPin, IconFolder, IconRefresh, IconClose, IconClock } from './icons';
import { writeSession } from '../ipc/session';
import { useT } from '../i18n';

function fmtUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}
function fmtMem(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  return `${Math.round(bytes / 1048576)} MB`;
}

export function Pane({ pane }: { pane: PaneModel }) {
  const runtime = useStore((s) => s.runtime[pane.id]);
  const focused = useStore((s) => s.focusedPaneId === pane.id);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const restartPane = useStore((s) => s.restartPane);
  const removePane = useStore((s) => s.removePane);
  const removeFromTab = useStore((s) => s.removeFromTab);
  const stopPane = useStore((s) => s.stopPane);
  const renamePane = useStore((s) => s.renamePane);
  const openEditCmd = useStore((s) => s.openEditCmd);
  const togglePinPane = useStore((s) => s.togglePinPane);
  const openSftpForPane = useStore((s) => s.openSftpForPane);
  const stat = useStore((s) => s.stats[pane.id]);
  const claudeSession = useStore((s) => s.claudeSessions[pane.id]);
  const sshStatus = useStore((s) => s.sshStatus[pane.id]);
  const setSlot = useSlots((s) => s.setSlot);
  const now = useNow();
  const t = useT();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pane.name);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [claudeMenu, setClaudeMenu] = useState<{ x: number; y: number } | null>(null);
  const [sessionsOpen, setSessionsOpen] = useState(false);

  // Stable ref so the terminal only re-parents on mount/unmount, not every render.
  const slotRef = useCallback(
    (el: HTMLDivElement | null) => setSlot(pane.id, el),
    [pane.id, setSlot]
  );

  const openMenu = (e: MouseEvent) => {
    e.preventDefault();
    setFocusedPane(pane.id);
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const status = runtime?.status ?? 'running';
  const kind = pane.kind ?? 'shell';
  const isBrowser = kind === 'browser';
  const claudeRunning = status === 'running' && !!stat?.claude;
  const claudeBusy = claudeRunning && !!stat?.busy;
  const claudeWaiting = claudeRunning && !claudeBusy && !!claudeSession?.waitingForInput;

  /** Type a command into the pane (local PTY or SSH), then press Enter after a
   *  short pause (lets Claude's TUI settle before the submit keystroke). */
  const typeCommand = (text: string) => {
    setFocusedPane(pane.id);
    writeSession(pane, text);
    window.setTimeout(() => writeSession(pane, '\r'), 160);
  };

  const claudeItems: MenuItem[] = claudeRunning
    ? [
        { label: t('claude.remote'), onClick: () => typeCommand('/remote-control') },
        { label: t('claude.resume'), onClick: () => typeCommand('/resume') },
        { label: t('claude.model'), onClick: () => typeCommand('/model') },
        { label: t('claude.compact'), onClick: () => typeCommand('/compact') },
        { label: t('claude.clear'), onClick: () => typeCommand('/clear') },
        { label: t('claude.cost'), onClick: () => typeCommand('/cost') },
        { label: '', separator: true },
        { label: t('claude.esc'), onClick: () => writeSession(pane, '\x1b') },
        {
          label: t('claude.quit'),
          danger: true,
          onClick: () => {
            writeSession(pane, '\x03');
            window.setTimeout(() => writeSession(pane, '\x03'), 250);
          },
        },
      ]
    : [
        { label: t('claude.launch'), disabled: status !== 'running', onClick: () => typeCommand('claude') },
        {
          label: t('claude.continue'),
          disabled: status !== 'running',
          onClick: () => typeCommand('claude -c'),
        },
        {
          label: t('claude.pick'),
          disabled: status !== 'running',
          onClick: () => typeCommand('claude -r'),
        },
        {
          label: t('claude.browse'),
          disabled: status !== 'running' || !pane.cwd,
          onClick: () => setSessionsOpen(true),
        },
        {
          label: t('claude.danger'),
          disabled: status !== 'running',
          onClick: () => typeCommand('claude --dangerously-skip-permissions'),
        },
        { label: '', separator: true },
        {
          label: t('claude.update'),
          disabled: status !== 'running',
          onClick: () => typeCommand('claude update'),
        },
      ];

  const commitName = () => {
    setEditing(false);
    const v = draft.trim();
    if (v && v !== pane.name) renamePane(pane.id, v);
    else setDraft(pane.name);
  };

  return (
    <div
      className={`pane${focused ? ' focused' : ''}`}
      onMouseDown={() => setFocusedPane(pane.id)}
    >
      <div
        onContextMenu={openMenu}
        draggable={!editing}
        onDragStart={(e) => {
          e.dataTransfer.setData(SAVED_DND_MIME, pane.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 10px',
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border-2)',
          flex: 'none',
          cursor: 'grab',
        }}
      >
        <PaneBadge pane={pane} size={20} />
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName();
              if (e.key === 'Escape') {
                setDraft(pane.name);
                setEditing(false);
              }
            }}
            style={{
              font: '600 12px var(--font-ui)',
              color: 'var(--text)',
              background: 'var(--bg-panel)',
              border: '1px solid var(--accent)',
              borderRadius: 5,
              padding: '1px 5px',
              outline: 'none',
              width: 120,
            }}
          />
        ) : (
          <span
            title={t('pane.renameHint')}
            onDoubleClick={() => {
              setDraft(pane.name);
              setEditing(true);
            }}
            style={{
              font: '600 12px var(--font-ui)',
              color: status === 'exited' ? 'var(--text-2)' : 'var(--text)',
              cursor: 'text',
            }}
          >
            {pane.name}
          </span>
        )}
        {claudeRunning && (
          <ClaudeIcon
            size={13}
            color={claudeWaiting ? 'var(--warn)' : undefined}
            className={claudeBusy ? 'claude-pulse' : claudeWaiting ? 'claude-attn' : undefined}
            title={
              claudeWaiting
                ? t('claude.needAttention')
                : claudeBusy
                  ? t('pane.claudeBusyTip')
                  : t('pane.claudeIdleTip')
            }
          />
        )}
        <span
          style={{
            font: '400 10.5px var(--font-mono)',
            color: 'var(--text-muted)',
            flex: 1,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {pane.ssh
            ? `${pane.ssh.user}@${pane.ssh.host}:${pane.ssh.port}`
            : pane.cwd || t('common.default')}
        </span>
        {sshStatus?.state === 'reconnecting' && (
          <span
            className="ssh-reconnect"
            title={t('pane.sshReconnecting', { n: sshStatus.attempt })}
          >
            <IconRefresh size={11} className="icon-spin" /> {t('pane.sshReconnecting', { n: sshStatus.attempt })}
          </span>
        )}
        {pane.pinned && (
          <span title={t('pane.pinnedTip')} style={{ display: 'inline-flex', flex: 'none' }}>
            <IconPin size={12} />
          </span>
        )}
        {!isBrowser && (
          <span
            title={status === 'running' ? t('pane.running') : t('pane.exited', { code: runtime?.exitCode ?? 0 })}
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              flex: 'none',
              background: status === 'running' ? 'var(--accent)' : 'var(--text-muted)',
              boxShadow: status === 'running' ? '0 0 6px rgba(45,212,167,0.8)' : 'none',
            }}
          />
        )}
        {!isBrowser && (
          <span
            className="pane-ctl"
            title={claudeRunning ? t('pane.claudeQuick') : t('pane.claudeRun')}
            onClick={(e) => {
              e.stopPropagation();
              setFocusedPane(pane.id);
              setClaudeMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            <ClaudeIcon size={13} color={claudeRunning ? undefined : 'var(--text-muted)'} />
          </span>
        )}
        {kind === 'ssh' && (
          <span
            className="pane-ctl"
            title={t('pane.openSftp')}
            onClick={(e) => {
              e.stopPropagation();
              openSftpForPane(pane.id);
            }}
          >
            <IconFolder size={14} />
          </span>
        )}
        <span
          className="pane-ctl"
          title={isBrowser ? t('pane.reconnect') : t('pane.restart')}
          onClick={() => restartPane(pane.id)}
        >
          <IconRefresh size={14} />
        </span>
        <span
          className="pane-ctl"
          title={t('pane.hide')}
          onClick={() => removeFromTab(pane.id)}
        >
          <IconClose size={13} />
        </span>
      </div>

      {status === 'exited' ? (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', minHeight: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, maxWidth: 420, padding: '0 16px' }}>
            {runtime?.exitError ? (
              <div style={{ font: '400 11.5px var(--font-mono)', color: 'var(--danger)', textAlign: 'center', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {runtime.exitError}
              </div>
            ) : (
              <div style={{ font: '400 11.5px var(--font-mono)', color: 'var(--text-muted)' }}>
                {runtime?.exitCode === undefined
                  ? t('pane.notStarted')
                  : t('pane.exitedMsg', { code: runtime.exitCode })}
              </div>
            )}
            <button className="outline-accent-btn" onClick={() => restartPane(pane.id)}>
              {t('pane.reopenPath')}
            </button>
          </div>
        </div>
      ) : isBrowser ? (
        <FileBrowser key={runtime?.nonce ?? 0} pane={pane} />
      ) : (
        <div ref={slotRef} style={{ flex: 1, minHeight: 0, minWidth: 0 }} />
      )}

      {claudeRunning && claudeSession?.found && (
        <ClaudePanel session={claudeSession} busy={claudeBusy} />
      )}

      {!isBrowser && status === 'running' && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            height: 20,
            padding: '0 10px',
            borderTop: '1px solid var(--border-2)',
            background: 'var(--bg-panel)',
            font: '400 10px var(--font-mono)',
            color: 'var(--text-muted)',
            flex: 'none',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          <span title={t('pane.uptime')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <IconClock size={11} /> {fmtUptime(now - (runtime?.startedAt ?? now))}
          </span>
          <span title="CPU">CPU {stat ? stat.cpu.toFixed(1) : '0.0'}%</span>
          <span title="RAM">RAM {stat ? fmtMem(stat.mem) : '—'}</span>
          {claudeRunning && (
            <span
              title={claudeBusy ? t('pane.claudeBusy') : t('pane.claudeIdle')}
              style={{ color: '#d97757', display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <ClaudeIcon size={10} className={claudeBusy ? 'claude-pulse' : undefined} />
              {claudeBusy ? t('pane.claudeBusyShort') : t('pane.claudeIdleShort')}
            </span>
          )}
          {claudeRunning && (
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
              <button
                className="claude-chip"
                title={t('claude.chipRemote')}
                onClick={() => typeCommand('/remote-control')}
              >
                Remote
              </button>
              <button
                className="claude-chip"
                title={t('claude.chipResume')}
                onClick={() => typeCommand('/resume')}
              >
                Resume
              </button>
              <button
                className="claude-chip"
                title={t('claude.chipCompact')}
                onClick={() => typeCommand('/compact')}
              >
                Compact
              </button>
              <button
                className="claude-chip"
                title={t('claude.chipEsc')}
                onClick={() => writeSession(pane, '\x1b')}
              >
                Esc
              </button>
            </span>
          )}
        </div>
      )}

      {claudeMenu && (
        <ContextMenu
          x={claudeMenu.x}
          y={claudeMenu.y}
          onClose={() => setClaudeMenu(null)}
          items={claudeItems}
        />
      )}

      {sessionsOpen && (
        <ClaudeSessionsDialog
          cwd={pane.cwd}
          onClose={() => setSessionsOpen(false)}
          onPick={(id) => {
            setSessionsOpen(false);
            typeCommand(`claude -r ${id}`);
          }}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: t('pane.editTerminal'), onClick: () => openEditCmd(pane.id) },
            ...(kind === 'ssh'
              ? [{ label: t('pane.openSftp'), onClick: () => openSftpForPane(pane.id) }]
              : []),
            {
              label: pane.pinned ? t('pane.unpin') : t('pane.pin'),
              onClick: () => togglePinPane(pane.id),
            },
            {
              label: status === 'running' ? t('pane.stopTerminal') : t('pane.reopen'),
              onClick: () => (status === 'running' ? stopPane(pane.id) : restartPane(pane.id)),
            },
            { label: '', separator: true },
            { label: t('pane.deleteTerminal'), danger: true, onClick: () => removePane(pane.id) },
          ]}
        />
      )}
    </div>
  );
}
