import { useState, useCallback, type MouseEvent } from 'react';
import type { Pane as PaneModel } from '../types';
import { useStore } from '../state/store';
import { useSlots } from '../state/slots';
import { ShellBadge } from './ShellBadge';
import { ContextMenu } from './ContextMenu';

export function Pane({ pane }: { pane: PaneModel }) {
  const runtime = useStore((s) => s.runtime[pane.id]);
  const focused = useStore((s) => s.focusedPaneId === pane.id);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const restartPane = useStore((s) => s.restartPane);
  const removePane = useStore((s) => s.removePane);
  const renamePane = useStore((s) => s.renamePane);
  const openEditCmd = useStore((s) => s.openEditCmd);
  const togglePinPane = useStore((s) => s.togglePinPane);
  const setSlot = useSlots((s) => s.setSlot);

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
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 10px',
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border-2)',
          flex: 'none',
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
          className="pane-ctl danger"
          title="Đóng cmd"
          style={{ fontSize: 11 }}
          onClick={() => removePane(pane.id)}
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

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Sửa CMD', onClick: () => openEditCmd(pane.id) },
            {
              label: pane.pinned ? 'Bỏ ghim CMD' : 'Ghim CMD',
              onClick: () => togglePinPane(pane.id),
            },
            { label: 'Mở lại (restart)', onClick: () => restartPane(pane.id) },
            { label: '', separator: true },
            { label: 'Xóa CMD', danger: true, onClick: () => removePane(pane.id) },
          ]}
        />
      )}
    </div>
  );
}
