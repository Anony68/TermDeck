import { useState } from 'react';
import { useStore, displayItems } from '../state/store';
import { ContextMenu } from './ContextMenu';
import { ClaudeIcon } from './ClaudeIcon';
import { IconPin, IconPlus } from './icons';
import { TAB_DND_MIME } from '../dnd';
import { useT } from '../i18n';

export function TabStrip() {
  const tabs = useStore((s) => s.tabs);
  const panes = useStore((s) => s.panes);
  const stats = useStore((s) => s.stats);
  const activeTabId = useStore((s) => s.activeTabId);
  const tt = useT();
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
          const shown = displayItems(t, panes);
          const hasClaude = shown.some((i) => stats[i.paneId]?.claude);
          const claudeBusy = shown.some((i) => stats[i.paneId]?.claude && stats[i.paneId]?.busy);
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
                  padding: '6px 12px',
                  background: 'var(--surface-3)',
                  border: '1px solid var(--accent)',
                  borderRadius: 8,
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
              className={`tab-pill${active ? ' active' : ''}`}
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
                setMenu({ x: e.clientX, y: e.clientY, tabId: t.id });
              }}
              style={{ outline: dragOverId === t.id ? '1.5px dashed var(--accent)' : undefined }}
            >
              {t.pinned ? (
                <span title={tt('tab.pinned')} style={{ display: 'inline-flex', flex: 'none' }}>
                  <IconPin size={11} />
                </span>
              ) : (
                active && (
                  <span
                    style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' }}
                  />
                )
              )}
              {hasClaude && (
                <ClaudeIcon
                  size={11}
                  className={claudeBusy ? 'claude-pulse' : undefined}
                  title={claudeBusy ? tt('tab.claudeBusy') : tt('tab.claudeIdle')}
                />
              )}
              {t.name}
            </div>
          );
        })}
        <div
          title={tt('tab.new')}
          onClick={addTab}
          className="icon-btn"
          style={{ padding: '6px 10px' }}
        >
          <IconPlus size={16} />
        </div>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: tt('tab.rename'),
              onClick: () => {
                const t = tabs.find((x) => x.id === menu.tabId);
                if (t) startRename(t.id, t.name);
              },
            },
            {
              label: menuTab?.pinned ? tt('tab.unpin') : tt('tab.pin'),
              onClick: () => togglePinTab(menu.tabId),
            },
            { label: tt('tab.new'), onClick: addTab },
            { label: '', separator: true },
            { label: tt('tab.close'), danger: true, onClick: () => closeTab(menu.tabId) },
          ]}
        />
      )}
    </>
  );
}
