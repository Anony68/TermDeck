import { useState, useCallback, type MouseEvent } from 'react';
import type { Pane as PaneModel } from '../types';
import { useStore } from '../state/store';
import { useSlots } from '../state/slots';
import { SAVED_DND_MIME } from '../dnd';
import { useNow } from '../useNow';
import { PaneBadge } from './ShellBadge';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { ClaudeIcon } from './ClaudeIcon';
import { FileBrowser } from './FileBrowser';
import { writePty } from '../ipc/pty';

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
  const stat = useStore((s) => s.stats[pane.id]);
  const setSlot = useSlots((s) => s.setSlot);
  const now = useNow();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pane.name);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [claudeMenu, setClaudeMenu] = useState<{ x: number; y: number } | null>(null);

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

  /** Type a command into the pane's PTY, then press Enter after a short pause
   *  (the pause lets Claude's TUI settle before the submit keystroke). */
  const typeCommand = (text: string) => {
    setFocusedPane(pane.id);
    writePty(pane.id, text);
    window.setTimeout(() => writePty(pane.id, '\r'), 160);
  };

  const claudeItems: MenuItem[] = claudeRunning
    ? [
        { label: 'Điều khiển từ xa (/remote-control)', onClick: () => typeCommand('/remote-control') },
        { label: 'Tiếp tục phiên cũ (/resume)', onClick: () => typeCommand('/resume') },
        { label: 'Đổi model (/model)', onClick: () => typeCommand('/model') },
        { label: 'Nén hội thoại (/compact)', onClick: () => typeCommand('/compact') },
        { label: 'Xóa hội thoại (/clear)', onClick: () => typeCommand('/clear') },
        { label: 'Xem chi phí (/cost)', onClick: () => typeCommand('/cost') },
        { label: '', separator: true },
        { label: 'Ngắt thao tác (Esc)', onClick: () => writePty(pane.id, '\x1b') },
        {
          label: 'Thoát Claude (Ctrl+C ×2)',
          danger: true,
          onClick: () => {
            writePty(pane.id, '\x03');
            window.setTimeout(() => writePty(pane.id, '\x03'), 250);
          },
        },
      ]
    : [
        { label: 'Chạy Claude', disabled: status !== 'running', onClick: () => typeCommand('claude') },
        {
          label: 'Tiếp tục phiên trước (claude -c)',
          disabled: status !== 'running',
          onClick: () => typeCommand('claude -c'),
        },
        {
          label: 'Chọn phiên để mở (claude -r)',
          disabled: status !== 'running',
          onClick: () => typeCommand('claude -r'),
        },
        {
          label: 'Chạy bỏ qua xác nhận (nguy hiểm)',
          disabled: status !== 'running',
          onClick: () => typeCommand('claude --dangerously-skip-permissions'),
        },
        { label: '', separator: true },
        {
          label: 'Cập nhật Claude (claude update)',
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
            title="Nhấp đúp để đổi tên"
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
            className={claudeBusy ? 'claude-pulse' : undefined}
            title={claudeBusy ? 'Claude Code — đang xử lý' : 'Claude Code — đang chờ lệnh'}
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
            : pane.cwd || '(mặc định)'}
        </span>
        {pane.pinned && (
          <span title="Đã ghim — hiện ở mọi tab" style={{ fontSize: 11, lineHeight: 1 }}>
            📌
          </span>
        )}
        {!isBrowser && (
          <span
            title={status === 'running' ? 'Đang chạy' : `Đã kết thúc (exit ${runtime?.exitCode ?? 0})`}
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
            title={claudeRunning ? 'Lệnh nhanh Claude Code' : 'Claude Code — chạy trong terminal này'}
            onClick={(e) => {
              e.stopPropagation();
              setFocusedPane(pane.id);
              setClaudeMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            <ClaudeIcon size={13} color={claudeRunning ? undefined : 'var(--text-muted)'} />
          </span>
        )}
        <span
          className="pane-ctl"
          title={isBrowser ? 'Kết nối lại' : 'Mở lại (restart)'}
          onClick={() => restartPane(pane.id)}
        >
          ⟳
        </span>
        <span
          className="pane-ctl"
          title="Ẩn khỏi tab này (cmd vẫn chạy nền)"
          style={{ fontSize: 11 }}
          onClick={() => removeFromTab(pane.id)}
        >
          ✕
        </span>
      </div>

      {isBrowser ? (
        <FileBrowser pane={pane} />
      ) : status === 'exited' ? (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', minHeight: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <div style={{ font: '400 11.5px var(--font-mono)', color: 'var(--text-muted)' }}>
              Tiến trình đã kết thúc (exit {runtime?.exitCode ?? 0})
            </div>
            <button className="outline-accent-btn" onClick={() => restartPane(pane.id)}>
              ⟳ Mở lại đúng path
            </button>
          </div>
        </div>
      ) : (
        <div ref={slotRef} style={{ flex: 1, minHeight: 0, minWidth: 0 }} />
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
          <span title="Thời gian chạy">⏱ {fmtUptime(now - (runtime?.startedAt ?? now))}</span>
          <span title="CPU">CPU {stat ? stat.cpu.toFixed(1) : '0.0'}%</span>
          <span title="RAM">RAM {stat ? fmtMem(stat.mem) : '—'}</span>
          {claudeRunning && (
            <span
              title={claudeBusy ? 'Claude đang xử lý' : 'Claude đang chờ lệnh'}
              style={{ color: '#d97757', display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <ClaudeIcon size={10} className={claudeBusy ? 'claude-pulse' : undefined} />
              {claudeBusy ? 'đang xử lý…' : 'sẵn sàng'}
            </span>
          )}
          {claudeRunning && (
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
              <button
                className="claude-chip"
                title="/remote-control — điều khiển phiên này từ claude.ai / điện thoại"
                onClick={() => typeCommand('/remote-control')}
              >
                Remote
              </button>
              <button
                className="claude-chip"
                title="/resume — tiếp tục phiên cũ"
                onClick={() => typeCommand('/resume')}
              >
                Resume
              </button>
              <button
                className="claude-chip"
                title="/compact — nén hội thoại để tiết kiệm context"
                onClick={() => typeCommand('/compact')}
              >
                Compact
              </button>
              <button
                className="claude-chip"
                title="Gửi phím Esc — ngắt thao tác Claude đang chạy"
                onClick={() => writePty(pane.id, '\x1b')}
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

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Sửa Terminal', onClick: () => openEditCmd(pane.id) },
            {
              label: pane.pinned ? 'Bỏ ghim Terminal' : 'Ghim Terminal',
              onClick: () => togglePinPane(pane.id),
            },
            {
              label: status === 'running' ? 'Tắt Terminal' : 'Mở lại',
              onClick: () => (status === 'running' ? stopPane(pane.id) : restartPane(pane.id)),
            },
            { label: '', separator: true },
            { label: 'Xóa Terminal', danger: true, onClick: () => removePane(pane.id) },
          ]}
        />
      )}
    </div>
  );
}
