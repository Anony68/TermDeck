import { useState } from 'react';
import { useStore } from '../state/store';
import { SAVED_DND_MIME } from '../dnd';
import { ShellBadge } from './ShellBadge';

export function Sidebar() {
  const library = useStore((s) => s.library);
  const openPaneFromSaved = useStore((s) => s.openPaneFromSaved);
  const removeFromLibrary = useStore((s) => s.removeFromLibrary);
  // Saved cmds that currently have a running process (lit up in the list).
  const runningKey = useStore((s) =>
    s.panes
      .filter((p) => p.savedCmdId && (s.runtime[p.id]?.status ?? 'running') === 'running')
      .map((p) => p.savedCmdId)
      .sort()
      .join(',')
  );
  const runningSet = new Set(runningKey ? runningKey.split(',') : []);
  const [query, setQuery] = useState('');

  const filtered = library.filter(
    (c) =>
      c.name.toLowerCase().includes(query.toLowerCase()) ||
      c.cwd.toLowerCase().includes(query.toLowerCase())
  );

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
          padding: '14px 14px 8px',
          font: '600 10.5px var(--font-ui)',
          color: 'var(--text-muted)',
          letterSpacing: '0.08em',
        }}
      >
        CMD ĐÃ LƯU
      </div>
      <div style={{ margin: '0 12px 10px', display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ color: 'var(--text-muted)' }}>⌕</span>
        <input
          className="field"
          placeholder="Tìm kiếm…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ padding: '6px 8px', fontSize: 11.5 }}
        />
      </div>
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          padding: '0 8px',
          minHeight: 0,
        }}
      >
        {filtered.length === 0 && (
          <div
            style={{
              padding: '18px 10px',
              font: '400 11.5px var(--font-ui)',
              color: 'var(--text-faint)',
              textAlign: 'center',
              lineHeight: 1.6,
            }}
          >
            {library.length === 0
              ? 'Chưa có cmd nào được lưu. Tạo bằng "＋ Cmd mới" và bật "Lưu vào thư viện".'
              : 'Không tìm thấy cmd phù hợp.'}
          </div>
        )}
        {filtered.map((c) => {
          const running = runningSet.has(c.id);
          return (
          <div
            key={c.id}
            className="side-item"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(SAVED_DND_MIME, c.id);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => openPaneFromSaved(c.id)}
            title={running ? 'Đang chạy · nhấp để đưa về tab này' : 'Nhấp để mở · kéo thả vào ô cụ thể'}
            style={running ? { background: 'rgba(45,212,167,0.07)', borderColor: 'rgba(45,212,167,0.35)' } : undefined}
          >
            <ShellBadge shell={c.shell} size={22} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  font: '600 12px var(--font-ui)',
                  color: running ? 'var(--accent)' : 'var(--text)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {c.name}
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
            {running && (
              <span
                title="Đang chạy"
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  flex: 'none',
                  background: 'var(--accent)',
                  boxShadow: '0 0 6px rgba(45,212,167,0.8)',
                }}
              />
            )}
            <span
              className="pane-ctl danger"
              title="Xoá khỏi thư viện"
              onClick={(e) => {
                e.stopPropagation();
                removeFromLibrary(c.id);
              }}
              style={{ width: 18, height: 18, fontSize: 10 }}
            >
              ✕
            </span>
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
        Kéo thả vào grid để mở
      </div>
    </div>
  );
}
