import { useState, useCallback, type MouseEvent } from 'react';
import type { Pane as PaneModel } from '../types';
import { useStore } from '../state/store';
import { useSlots } from '../state/slots';
import { SAVED_DND_MIME } from '../dnd';
import { useNow } from '../useNow';
import { ShellBadge } from './ShellBadge';
import { ContextMenu } from './ContextMenu';

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
        <ShellBadge shell={pane.shell} size={20} />
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
          {pane.cwd || '(mặc định)'}
        </span>
        {pane.pinned && (
          <span title="Đã ghim — hiện ở mọi tab" style={{ fontSize: 11, lineHeight: 1 }}>
            📌
          </span>
        )}
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
        <span
          className="pane-ctl"
          title="Mở lại (restart)"
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

      {status === 'exited' ? (
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

      {status === 'running' && (
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
        </div>
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
