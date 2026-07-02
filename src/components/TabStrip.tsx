import { useState } from 'react';
import { useStore } from '../state/store';
import { ContextMenu } from './ContextMenu';
import { TAB_DND_MIME } from '../dnd';

export function TabStrip() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const addTab = useStore((s) => s.addTab);
  const closeTab = useStore((s) => s.closeTab);
  const renameTab = useStore((s) => s.renameTab);
  const reorderTab = useStore((s) => s.reorderTab);
  const togglePinTab = useStore((s) => s.togglePinTab);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const startRename = (id: string, name: string) => {
    setDraft(name);
    setEditingId(id);
  };
  const commit = (id: string) => {
    const v = draft.trim();
    if (v) renameTab(id, v);
    setEditingId(null);
  };

  // Pinned tabs render first (stable within each group).
  const ordered = [...tabs].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  const menuTab = menu ? tabs.find((t) => t.id === menu.tabId) : undefined;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2 }}>
        {ordered.map((t) => {
          const active = t.id === activeTabId;
          if (editingId === t.id) {
            return (
              <input
                key={t.id}
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commit(t.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit(t.id);
                  if (e.key === 'Escape') setEditingId(null);
                }}
                style={{
                  padding: '7px 10px',
                  background: 'var(--surface)',
                  border: '1px solid var(--accent)',
                  borderRadius: '8px 8px 0 0',
                  font: '600 12px var(--font-ui)',
                  color: 'var(--text)',
                  outline: 'none',
                  width: 110,
                }}
              />
            );
          }
          return (
            <div
              key={t.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(TAB_DND_MIME, t.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes(TAB_DND_MIME)) {
                  e.preventDefault();
                  setDragOverId(t.id);
                }
              }}
              onDragLeave={() => setDragOverId((cur) => (cur === t.id ? null : cur))}
              onDrop={(e) => {
                const id = e.dataTransfer.getData(TAB_DND_MIME);
                setDragOverId(null);
                if (id && id !== t.id) reorderTab(id, t.id);
              }}
              onClick={() => setActiveTab(t.id)}
              onDoubleClick={() => startRename(t.id, t.name)}
              onContextMenu={(e) => {
                e.preventDefault();
                setActiveTab(t.id);
                setMenu({ x: e.clientX, y: e.clientY, tabId: t.id });
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                padding: '8px 14px',
                background: active ? 'var(--surface)' : 'transparent',
                border: active ? '1px solid var(--border-2)' : '1px solid transparent',
                borderBottom: 'none',
                borderRadius: '8px 8px 0 0',
                outline: dragOverId === t.id ? '1px dashed var(--accent)' : 'none',
                outlineOffset: '-1px',
                font: `${active ? 600 : 400} 12px var(--font-ui)`,
                color: active ? 'var(--text)' : 'var(--text-2)',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {t.pinned ? (
                <span title="Tab đã ghim" style={{ fontSize: 10, lineHeight: 1 }}>
                  📌
                </span>
              ) : (
                active && (
                  <span
                    style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' }}
                  />
                )
              )}
              {t.name}
              <span
                className="tab-x"
                title="Đóng tab"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
                style={{ color: 'var(--text-muted)', fontWeight: 400, padding: '0 2px', borderRadius: 4 }}
              >
                ✕
              </span>
            </div>
          );
        })}
        <div
          title="Tab mới"
          onClick={addTab}
          className="icon-btn"
          style={{ padding: '6px 10px', font: '400 14px var(--font-ui)' }}
        >
          ＋
        </div>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: 'Đổi tên tab',
              onClick: () => {
                const t = tabs.find((x) => x.id === menu.tabId);
                if (t) startRename(t.id, t.name);
              },
            },
            {
              label: menuTab?.pinned ? 'Bỏ ghim tab' : 'Ghim tab',
              onClick: () => togglePinTab(menu.tabId),
            },
            { label: 'Tab mới', onClick: addTab },
            { label: '', separator: true },
            { label: 'Đóng tab', danger: true, onClick: () => closeTab(menu.tabId) },
          ]}
        />
      )}
    </>
  );
}
