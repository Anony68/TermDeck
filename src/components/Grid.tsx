import { useState } from 'react';
import { useStore, activeTabSelector, displayItems } from '../state/store';
import { LAYOUTS, fitLayout } from '../layouts';
import { SAVED_DND_MIME } from '../dnd';
import { Pane } from './Pane';
import { useT } from '../i18n';

export function Grid() {
  const tab = useStore(activeTabSelector);
  const panes = useStore((s) => s.panes);
  const openAddCmd = useStore((s) => s.openAddCmd);
  const showPaneInTab = useStore((s) => s.showPaneInTab);
  const movePaneToSlot = useStore((s) => s.movePaneToSlot);
  const [dragSlot, setDragSlot] = useState<number | null>(null);
  const t = useT();

  if (!tab) return null;
  // This tab shows its own referenced cmds + any pinned cmds; grid grows to fit them.
  const items = displayItems(tab, panes);
  const layout = LAYOUTS[fitLayout(items.length, tab.layout)];
  const slots = Array.from({ length: layout.capacity }, (_, i) => i);
  const paneById = new Map(panes.map((p) => [p.id, p]));
  const paneBySlot = new Map(items.map((it) => [it.slot, paneById.get(it.paneId)!]));

  return (
    <div
      style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: layout.columns,
        gridTemplateRows: layout.rows,
        gap: 10,
        padding: 12,
        minHeight: 0,
        minWidth: 0,
      }}
    >
      {slots.map((slot) => {
        const pane = paneBySlot.get(slot);
        const spanStyle = layout.bigSlot === slot ? { gridRow: '1 / 3' } : undefined;
        const isOver = dragSlot === slot;
        return (
          <div
            key={slot}
            style={{ minHeight: 0, minWidth: 0, display: 'flex', ...spanStyle }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(SAVED_DND_MIME)) {
                e.preventDefault();
                setDragSlot(slot);
              }
            }}
            onDragLeave={() => setDragSlot((cur) => (cur === slot ? null : cur))}
            onDrop={(e) => {
              const id = e.dataTransfer.getData(SAVED_DND_MIME);
              setDragSlot(null);
              if (id) {
                if (items.some((i) => i.paneId === id)) movePaneToSlot(id, slot);
                else showPaneInTab(id, slot);
              }
            }}
          >
            {pane ? (
              <Pane pane={pane} />
            ) : (
              <button
                onClick={() => openAddCmd(slot)}
                style={{
                  flex: 1,
                  width: '100%',
                  border: `1px dashed ${isOver ? 'var(--accent)' : 'var(--border-3)'}`,
                  borderRadius: 8,
                  background: isOver ? 'var(--accent-soft-2)' : 'transparent',
                  color: isOver ? 'var(--accent)' : 'var(--text-faint)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  cursor: 'pointer',
                  minHeight: 0,
                }}
              >
                <span style={{ fontSize: 20 }}>＋</span>
                <span style={{ font: '400 11px var(--font-ui)' }}>{t('grid.emptySlot')}</span>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
