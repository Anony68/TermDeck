import { useState } from 'react';
import { useStore } from '../state/store';
import { SAVED_DND_MIME } from '../dnd';
import { PaneBadge } from './ShellBadge';
import { ContextMenu } from './ContextMenu';
import { ClaudeIcon } from './ClaudeIcon';
import { useT, type TKey } from '../i18n';
import type { Pane, PaneKind, Project } from '../types';

type TypeFilter = 'all' | PaneKind;

const TYPE_CHIPS: Array<{ k: TypeFilter; key: TKey }> = [
  { k: 'all', key: 'sidebar.typeAll' },
  { k: 'shell', key: 'sidebar.typeShell' },
  { k: 'ssh', key: 'sidebar.typeSsh' },
  { k: 'browser', key: 'sidebar.typeFiles' },
];

const kindOf = (p: Pane): PaneKind => p.kind ?? 'shell';

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
  const openSettings = useStore((s) => s.openSettings);
  const t = useT();

  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all'); // 'all' | '__none__' | projectId
  const [menu, setMenu] = useState<{ x: number; y: number; paneId: string } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const menuPane = menu ? panes.find((p) => p.id === menu.paneId) : undefined;
  const menuRunning = menu ? (runtime[menu.paneId]?.status ?? 'running') === 'running' : false;

  const isUngrouped = (p: Pane) => !p.projectId || !projects.some((pr) => pr.id === p.projectId);

  // Base = query + type filters (project filter applied after, so chip counts are stable).
  const base = panes.filter(
    (c) =>
      (typeFilter === 'all' || kindOf(c) === typeFilter) &&
      (c.name.toLowerCase().includes(query.toLowerCase()) ||
        c.cwd.toLowerCase().includes(query.toLowerCase()))
  );
  const noneCount = base.filter(isUngrouped).length;
  const filtered = base.filter((p) =>
    projectFilter === 'all'
      ? true
      : projectFilter === '__none__'
        ? isUngrouped(p)
        : p.projectId === projectFilter
  );

  // Group by project only in "all projects" mode; a specific filter shows a flat list.
  const groups: Array<{ key: string; project?: Project; items: Pane[] }> = [];
  if (projectFilter === 'all') {
    for (const proj of projects) {
      const items = filtered.filter((p) => p.projectId === proj.id);
      if (items.length) groups.push({ key: proj.id, project: proj, items });
    }
    const ungrouped = filtered.filter(isUngrouped);
    if (ungrouped.length) groups.push({ key: '__none__', items: ungrouped });
  } else {
    groups.push({ key: projectFilter, items: filtered });
  }

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
        title={running ? t('sidebar.itemRunning') : t('sidebar.itemStopped')}
      >
        <span
          title={running ? t('sidebar.running') : t('sidebar.stopped')}
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
                title={stats[c.id]?.busy ? t('sidebar.claudeBusy') : t('sidebar.claudeIdle')}
              />
            )}
            {c.pinned && (
              <span title={t('sidebar.pinned')} style={{ fontSize: 10 }}>
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
            {c.cwd || t('common.default')}
          </div>
        </div>
        <span
          className={`pane-ctl${running ? ' danger' : ''}`}
          title={running ? t('sidebar.stop') : t('sidebar.restart')}
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
        {t('sidebar.title')}
      </div>
      <div style={{ padding: '0 12px 8px' }}>
        <button className="accent-btn" style={{ width: '100%', justifyContent: 'center' }} onClick={() => openAddCmd()}>
          {t('sidebar.newTerminal')}
        </button>
      </div>
      <div style={{ margin: '2px 12px 8px', display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ color: 'var(--text-muted)' }}>⌕</span>
        <input
          className="field"
          placeholder={t('sidebar.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ padding: '6px 8px', fontSize: 11.5 }}
        />
      </div>

      {/* Type filter */}
      <div style={{ display: 'flex', gap: 4, padding: '0 12px 8px' }}>
        {TYPE_CHIPS.map((c) => {
          const n = c.k === 'all' ? base.length : base.filter((p) => kindOf(p) === c.k).length;
          return (
            <button
              key={c.k}
              className={`side-chip${typeFilter === c.k ? ' active' : ''}`}
              onClick={() => setTypeFilter(c.k)}
              style={{ flex: 1 }}
            >
              {t(c.key)} <span style={{ opacity: 0.6 }}>{n}</span>
            </button>
          );
        })}
      </div>

      {/* Projects — prominent filter bar + manage shortcut */}
      <div style={{ padding: '0 12px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 5 }}>
          <span style={{ font: '700 10px var(--font-ui)', color: 'var(--accent)', letterSpacing: '0.08em', flex: 1 }}>
            📁 {t('sidebar.projects')}
          </span>
          <span
            className="link-btn"
            title={t('sidebar.manageProjects')}
            onClick={() => openSettings('projects')}
            style={{ fontSize: 10.5 }}
          >
            {t('sidebar.manageProjects')} ⚙
          </span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          <button
            className={`side-chip${projectFilter === 'all' ? ' active' : ''}`}
            onClick={() => setProjectFilter('all')}
          >
            {t('sidebar.allProjects')} <span style={{ opacity: 0.6 }}>{base.length}</span>
          </button>
          {projects.map((pr) => {
            const n = base.filter((p) => p.projectId === pr.id).length;
            return (
              <button
                key={pr.id}
                className={`side-chip${projectFilter === pr.id ? ' active' : ''}`}
                onClick={() => setProjectFilter(pr.id)}
                title={pr.path || pr.name}
              >
                {pr.name} <span style={{ opacity: 0.6 }}>{n}</span>
              </button>
            );
          })}
          {noneCount > 0 && (
            <button
              className={`side-chip${projectFilter === '__none__' ? ' active' : ''}`}
              onClick={() => setProjectFilter('__none__')}
            >
              {t('sidebar.noProject')} <span style={{ opacity: 0.6 }}>{noneCount}</span>
            </button>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '0 8px 8px', minHeight: 0, borderTop: '1px solid var(--border)' }}>
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
            {t('sidebar.empty')}
          </div>
        )}
        {panes.length > 0 && filtered.length === 0 && (
          <div style={{ padding: '18px 10px', font: '400 11.5px var(--font-ui)', color: 'var(--text-faint)', textAlign: 'center' }}>
            {t('sidebar.noMatch')}
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
                  {g.project && <span style={{ fontSize: 10 }}>📁</span>}
                  <span
                    style={{
                      textTransform: 'uppercase',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      flex: 1,
                      color: g.project ? 'var(--text-2)' : 'var(--text-muted)',
                    }}
                  >
                    {g.project ? g.project.name : t('sidebar.other')}
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
        {t('sidebar.hint')}
      </div>

      {menu && menuPane && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: t('pane.editTerminal'), onClick: () => openEditCmd(menu.paneId) },
            {
              label: menuPane.pinned ? t('pane.unpin') : t('pane.pin'),
              onClick: () => togglePinPane(menu.paneId),
            },
            {
              label: menuRunning ? t('pane.stopTerminal') : t('pane.reopen'),
              onClick: () => (menuRunning ? stopPane(menu.paneId) : restartPane(menu.paneId)),
            },
            { label: '', separator: true },
            { label: t('pane.deleteTerminal'), danger: true, onClick: () => removePane(menu.paneId) },
          ]}
        />
      )}
    </div>
  );
}
