import { useState } from 'react';
import { useStore } from '../state/store';
import { SAVED_DND_MIME } from '../dnd';
import { PaneBadge } from './ShellBadge';
import { ContextMenu } from './ContextMenu';
import { ClaudeIcon } from './ClaudeIcon';
import type { Pane, Project } from '../types';

export function Sidebar() {
  const panes = useStore((s) => s.panes);
  const projects = useStore((s) => s.projects);
  const runtime = useStore((s) => s.runtime);
  const stats = useStore((s) => s.stats);
  const showPaneInTab = useStore((s) => s.showPaneInTab);
  const stopPane = useStore((s) => s.stopPane);
  const restartPane = useStore((s) => s.restartPane);
  const removePane = useStore((s) => s.removePane);
  const togglePinPane = useStore((s) => s.togglePinPane);
  const openEditCmd = useStore((s) => s.openEditCmd);
  const openAddCmd = useStore((s) => s.openAddCmd);

  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; paneId: string } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const filtered = panes.filter(
    (c) =>
      c.name.toLowerCase().includes(query.toLowerCase()) ||
      c.cwd.toLowerCase().includes(query.toLowerCase())
  );
  const menuPane = menu ? panes.find((p) => p.id === menu.paneId) : undefined;
  const menuRunning = menu ? (runtime[menu.paneId]?.status ?? 'running') === 'running' : false;

  // Group terminals by project (projects in order, then an "other" group).
  const groups: Array<{ key: string; project?: Project; items: Pane[] }> = [];
  for (const proj of projects) {
    const items = filtered.filter((p) => p.projectId === proj.id);
    if (items.length) groups.push({ key: proj.id, project: proj, items });
  }
  const ungrouped = filtered.filter(
    (p) => !p.projectId || !projects.some((pr) => pr.id === p.projectId)
  );
  if (ungrouped.length) groups.push({ key: '__none__', items: ungrouped });

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const renderItem = (c: Pane) => {
    const running = (runtime[c.id]?.status ?? 'running') === 'running';
    return (
      <div
        key={c.id}
        className="side-item"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(SAVED_DND_MIME, c.id);
          e.dataTransfer.effectAllowed = 'copy';
        }}
        onClick={() => showPaneInTab(c.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, paneId: c.id });
        }}
        title={running ? 'Đang chạy · nhấp để hiện ở tab này' : 'Đã tắt · nhấp để chạy lại'}
      >
        <span
          title={running ? 'Đang chạy' : 'Đã tắt'}
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            flex: 'none',
            background: running ? 'var(--accent)' : 'var(--text-muted)',
            boxShadow: running ? '0 0 6px rgba(45,212,167,0.8)' : 'none',
          }}
        />
        <PaneBadge pane={c} size={22} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              font: '600 12px var(--font-ui)',
              color: running ? 'var(--text)' : 'var(--text-2)',
            }}
          >
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {c.name}
            </span>
            {running && stats[c.id]?.claude && (
              <ClaudeIcon
                size={11}
                className={stats[c.id]?.busy ? 'claude-pulse' : undefined}
                title={stats[c.id]?.busy ? 'Claude đang xử lý' : 'Claude đang chờ lệnh'}
              />
            )}
            {c.pinned && (
              <span title="Đã ghim" style={{ fontSize: 10 }}>
                📌
              </span>
            )}
          </div>
          <div
            style={{
              font: '400 10px var(--font-mono)',
              color: 'var(--text-muted)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {c.cwd || '(mặc định)'}
          </div>
        </div>
        <span
          className={`pane-ctl${running ? ' danger' : ''}`}
          title={running ? 'Dừng (Stop)' : 'Chạy lại'}
          onClick={(e) => {
            e.stopPropagation();
            running ? stopPane(c.id) : restartPane(c.id);
          }}
          style={{ width: 20, height: 20 }}
        >
          {running ? (
            <span style={{ width: 9, height: 9, background: 'var(--danger)', borderRadius: 2, display: 'block' }} />
          ) : (
            <span style={{ color: 'var(--accent)', fontSize: 11 }}>▶</span>
          )}
        </span>
      </div>
    );
  };

  return (
    <div
      style={{
        width: 230,
        flex: 'none',
        background: 'var(--bg-panel)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div
        style={{
          padding: '12px 12px 8px',
          font: '600 10.5px var(--font-ui)',
          color: 'var(--text-muted)',
          letterSpacing: '0.08em',
        }}
      >
        DANH SÁCH TERMINAL
      </div>
      <div style={{ padding: '0 12px 8px' }}>
        <button className="accent-btn" style={{ width: '100%', justifyContent: 'center' }} onClick={() => openAddCmd()}>
          ＋ Terminal mới
        </button>
      </div>
      <div style={{ margin: '2px 12px 10px', display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ color: 'var(--text-muted)' }}>⌕</span>
        <input
          className="field"
          placeholder="Tìm kiếm…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ padding: '6px 8px', fontSize: 11.5 }}
        />
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '0 8px 8px', minHeight: 0 }}>
        {panes.length === 0 && (
          <div
            style={{
              padding: '18px 10px',
              font: '400 11.5px var(--font-ui)',
              color: 'var(--text-faint)',
              textAlign: 'center',
              lineHeight: 1.6,
            }}
          >
            Chưa có terminal nào. Tạo bằng "＋ Terminal mới".
          </div>
        )}
        {panes.length > 0 && filtered.length === 0 && (
          <div style={{ padding: '18px 10px', font: '400 11.5px var(--font-ui)', color: 'var(--text-faint)', textAlign: 'center' }}>
            Không tìm thấy terminal phù hợp.
          </div>
        )}
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key);
          const showHeader = groups.length > 1 || g.project;
          return (
            <div key={g.key} style={{ marginBottom: 4 }}>
              {showHeader && (
                <div
                  onClick={() => toggle(g.key)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '7px 8px 4px',
                    font: '600 10px var(--font-ui)',
                    color: 'var(--text-muted)',
                    letterSpacing: '0.06em',
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                >
                  <span style={{ fontSize: 8, transform: isCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.12s' }}>
                    ▼
                  </span>
                  <span style={{ textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                    {g.project ? g.project.name : 'Khác'}
                  </span>
                  <span style={{ color: 'var(--text-faint)' }}>{g.items.length}</span>
                </div>
              )}
              {!isCollapsed && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {g.items.map(renderItem)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div
        style={{
          font: '400 10.5px var(--font-ui)',
          color: 'var(--text-faint)',
          padding: '10px 14px',
          borderTop: '1px solid var(--border)',
        }}
      >
        Kéo thả vào grid để hiện
      </div>

      {menu && menuPane && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Sửa Terminal', onClick: () => openEditCmd(menu.paneId) },
            {
              label: menuPane.pinned ? 'Bỏ ghim Terminal' : 'Ghim Terminal',
              onClick: () => togglePinPane(menu.paneId),
            },
            {
              label: menuRunning ? 'Tắt Terminal' : 'Mở lại',
              onClick: () => (menuRunning ? stopPane(menu.paneId) : restartPane(menu.paneId)),
            },
            { label: '', separator: true },
            { label: 'Xóa Terminal', danger: true, onClick: () => removePane(menu.paneId) },
          ]}
        />
      )}
    </div>
  );
}
