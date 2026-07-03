import { useEffect, useRef, useState, useCallback } from 'react';
import type { FileEntry } from '../ipc/ssh';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { joinPath } from './pathUtils';

export interface FsBackend {
  list: (path: string) => Promise<FileEntry[]>;
  mkdir: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string, isDir: boolean) => Promise<void>;
  /** Path separator + join, so local (\\) and remote (/) behave correctly. */
  sep: string;
}

function fmtSize(bytes: number, isDir: boolean): string {
  if (isDir) return '';
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
function fmtDate(unixSec: number): string {
  if (!unixSec) return '';
  const d = new Date(unixSec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * One side of the file manager (local or remote). Owns its own cwd, listing,
 * selection and toolbar. Emits selected paths up so the parent can transfer.
 *
 * NOTE: `backend` and `onPathChange` MUST be stable (memoized by the parent) —
 * they gate the load effect, and the host Pane re-renders every second.
 */
export function FilePanel({
  title,
  backend,
  initialPath,
  accent,
  transferLabel,
  onTransfer,
  onPathChange,
  refreshKey,
  syncLabel,
  onSync,
}: {
  title: string;
  backend: FsBackend;
  initialPath: string;
  accent: string;
  /** e.g. "Tải lên ▶" (local) or "◀ Tải xuống" (remote). */
  transferLabel: string;
  onTransfer: (entries: FileEntry[], fromPath: string) => void;
  /** Called whenever this panel's current directory changes (transfer destination). */
  onPathChange?: (path: string) => void;
  /** Bump to force a re-list (e.g. after a transfer completes on the other side). */
  refreshKey?: number;
  /** Optional "sync this whole directory" action, shown next to the transfer button. */
  syncLabel?: string;
  onSync?: () => void;
}) {
  const [path, setPath] = useState(initialPath);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; entry?: FileEntry } | null>(null);
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState(path);
  const [confirmDel, setConfirmDel] = useState<FileEntry[] | null>(null);
  const [marquee, setMarquee] = useState<{ top: number; height: number } | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef(-1); // last anchor index (for shift/keyboard range select)
  const typeahead = useRef<{ buf: string; ts: number }>({ buf: '', ts: 0 });
  // Active rubber-band drag: start Y (in list content coords) + base selection.
  const bandRef = useRef<{ y0: number; base: Set<string> } | null>(null);

  const load = useCallback(
    async (p: string) => {
      setLoading(true);
      setError(null);
      try {
        const list = await backend.list(p);
        list.sort((a, b) =>
          a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)
        );
        setEntries(list);
        setSelected(new Set());
        anchorRef.current = -1;
      } catch (e) {
        setError(String(e));
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [backend]
  );

  // Runs only when the directory or the refresh token changes (deps are stable).
  useEffect(() => {
    setPathDraft(path);
    onPathChange?.(path);
    void load(path);
  }, [path, load, refreshKey, onPathChange]);

  // End a rubber-band drag when the mouse is released anywhere.
  useEffect(() => {
    const up = () => {
      if (bandRef.current) {
        bandRef.current = null;
        setMarquee(null);
      }
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const go = (p: string) => setPath(p);
  const goParent = () => go(joinPath(path, '..', backend.sep));
  const openEntry = (e: FileEntry) => {
    if (e.isDir) go(joinPath(path, e.name, backend.sep));
  };

  const visible = filter
    ? entries.filter((e) => e.name.toLowerCase().includes(filter.toLowerCase()))
    : entries;

  const selectOnly = (name: string) => setSelected(new Set([name]));
  const selectRange = (a: number, b: number) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const next = new Set<string>();
    for (let i = lo; i <= hi && i < visible.length; i++) if (i >= 0) next.add(visible[i].name);
    setSelected(next);
  };
  const scrollToIndex = (i: number) => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${i}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  };

  // Y of a mouse event in the scroll container's content coordinates.
  const contentY = (clientY: number): number => {
    const el = listRef.current;
    if (!el) return 0;
    return clientY - el.getBoundingClientRect().top + el.scrollTop;
  };
  // Index of the row whose vertical extent contains content-Y (−1 if none/empty).
  const rowIndexAt = (y: number): number => {
    const el = listRef.current;
    if (!el) return -1;
    const rows = el.querySelectorAll<HTMLElement>('[data-idx]');
    for (const r of rows) {
      const top = r.offsetTop;
      if (y >= top && y < top + r.offsetHeight) return Number(r.dataset.idx);
    }
    return -1;
  };

  // Rubber-band select: pick every row intersecting the band [y0..y1], combined
  // with the base selection (for Ctrl-drag). A zero-height band = a plain click.
  const applyBand = (y1: number) => {
    const band = bandRef.current;
    if (!band) return;
    const top = Math.min(band.y0, y1);
    const bottom = Math.max(band.y0, y1);
    setMarquee({ top, height: bottom - top });
    const el = listRef.current;
    if (!el) return;
    const next = new Set(band.base);
    let last = -1;
    el.querySelectorAll<HTMLElement>('[data-idx]').forEach((r) => {
      const rTop = r.offsetTop;
      const rBot = rTop + r.offsetHeight;
      if (rBot > top && rTop < bottom) {
        const i = Number(r.dataset.idx);
        next.add(visible[i].name);
        last = i;
      }
    });
    setSelected(next);
    if (last >= 0) anchorRef.current = last;
  };

  const onListMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // let right-click open the context menu
    listRef.current?.focus();
    const y0 = contentY(e.clientY);
    const hit = rowIndexAt(y0);
    // Shift-click extends a range from the anchor without starting a band.
    if (e.shiftKey && anchorRef.current >= 0 && hit >= 0) {
      selectRange(anchorRef.current, hit);
      return;
    }
    const additive = e.ctrlKey || e.metaKey;
    bandRef.current = { y0, base: additive ? new Set(selected) : new Set() };
    applyBand(y0); // select the row under the cursor (or clear on empty space)
  };
  const onListMouseMove = (e: React.MouseEvent) => {
    if (bandRef.current) applyBand(contentY(e.clientY));
  };

  // Keyboard on the list: Backspace = parent, Delete = remove, F5 = reload,
  // letters = type-ahead jump, arrows = move.
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      goParent();
      return;
    }
    if (e.key === 'Delete') {
      e.preventDefault();
      const sel = selectedEntries();
      if (sel.length) setConfirmDel(sel);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!visible.length) return;
      const cur = anchorRef.current;
      const nextIdx =
        e.key === 'ArrowDown'
          ? Math.min(visible.length - 1, cur < 0 ? 0 : cur + 1)
          : Math.max(0, cur < 0 ? 0 : cur - 1);
      anchorRef.current = nextIdx;
      selectOnly(visible[nextIdx].name);
      scrollToIndex(nextIdx);
      return;
    }
    if (e.key === 'Enter') {
      const sel = visible[anchorRef.current];
      if (sel) openEntry(sel);
      return;
    }
    // Type-ahead: printable char jumps to the matching entry. A single char
    // (typed repeatedly) cycles through matches; accumulating chars narrows it.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (!visible.length) return;
      const now = Date.now();
      const ta = typeahead.current;
      const within = now - ta.ts <= 700;
      ta.buf = within ? ta.buf + e.key.toLowerCase() : e.key.toLowerCase();
      ta.ts = now;
      const b = ta.buf;
      // Single char: start just after the current item so repeats cycle. Multi
      // char: start from the top and take the first match.
      const start = b.length === 1 && anchorRef.current >= 0 ? anchorRef.current + 1 : 0;
      for (let k = 0; k < visible.length; k++) {
        const idx = (start + k) % visible.length;
        if (visible[idx].name.toLowerCase().startsWith(b)) {
          anchorRef.current = idx;
          selectOnly(visible[idx].name);
          scrollToIndex(idx);
          break;
        }
      }
    }
  };

  const selectedEntries = () => entries.filter((e) => selected.has(e.name));

  const doMkdir = async () => {
    const name = window.prompt('Tên thư mục mới:');
    if (!name?.trim()) return;
    try {
      await backend.mkdir(joinPath(path, name.trim(), backend.sep));
      void load(path);
    } catch (e) {
      alert(`Lỗi tạo thư mục: ${e}`);
    }
  };
  const doRename = async (entry: FileEntry) => {
    const name = window.prompt('Tên mới:', entry.name);
    if (!name?.trim() || name === entry.name) return;
    try {
      await backend.rename(
        joinPath(path, entry.name, backend.sep),
        joinPath(path, name.trim(), backend.sep)
      );
      void load(path);
    } catch (e) {
      alert(`Lỗi đổi tên: ${e}`);
    }
  };
  // Actual deletion — the confirm popup gates this.
  const performRemove = async (list: FileEntry[]) => {
    setConfirmDel(null);
    if (!list.length) return;
    try {
      for (const e of list) await backend.remove(joinPath(path, e.name, backend.sep), e.isDir);
      void load(path);
    } catch (e) {
      alert(`Lỗi xóa: ${e}`);
    }
  };

  const menuItems = (): MenuItem[] => {
    const sel = selectedEntries();
    const target = menu?.entry;
    const list = target && !selected.has(target.name) ? [target] : sel;
    return [
      { label: transferLabel, disabled: list.length === 0, onClick: () => onTransfer(list, path) },
      { label: 'Mở', disabled: !target?.isDir, onClick: () => target && openEntry(target) },
      { label: 'Đổi tên', disabled: !target, onClick: () => target && doRename(target) },
      { label: '', separator: true },
      { label: 'Thư mục mới', onClick: doMkdir },
      { label: 'Làm mới', onClick: () => load(path) },
      { label: '', separator: true },
      {
        label: 'Xóa',
        danger: true,
        disabled: list.length === 0,
        onClick: () => list.length && setConfirmDel(list),
      },
    ];
  };

  return (
    <div
      onKeyDown={(e) => {
        // F5 anywhere in the panel reloads THIS tree (webview reload is blocked).
        if (e.key === 'F5') {
          e.preventDefault();
          void load(path);
        }
      }}
      style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, flex: 1, position: 'relative' }}
    >
      {/* Header: title + toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 8px',
          borderBottom: '1px solid var(--border-2)',
          background: 'var(--surface-2)',
        }}
      >
        <span style={{ font: '700 11px var(--font-ui)', color: accent, letterSpacing: '0.03em' }}>
          {title}
        </span>
        <div style={{ display: 'flex', gap: 2, marginLeft: 'auto' }}>
          <button className="fb-tool" title="Lên thư mục cha (Backspace)" onClick={goParent}>
            ↑
          </button>
          <button className="fb-tool" title="Làm mới" onClick={() => load(path)}>
            ⟳
          </button>
          <button className="fb-tool" title="Thư mục mới" onClick={doMkdir}>
            ⊕
          </button>
        </div>
      </div>

      {/* Path bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 8px', borderBottom: '1px solid var(--border)' }}>
        {editingPath ? (
          <input
            autoFocus
            className="field mono"
            value={pathDraft}
            onChange={(e) => setPathDraft(e.target.value)}
            onBlur={() => setEditingPath(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setEditingPath(false);
                go(pathDraft.trim());
              }
              if (e.key === 'Escape') setEditingPath(false);
            }}
            style={{ padding: '3px 7px', fontSize: 11 }}
          />
        ) : (
          <div
            className="fb-path"
            title="Nhấp để sửa đường dẫn"
            onClick={() => {
              setPathDraft(path);
              setEditingPath(true);
            }}
          >
            {path || '(gốc — chọn ổ đĩa)'}
          </div>
        )}
      </div>

      {/* Filter */}
      <div style={{ padding: '5px 8px', borderBottom: '1px solid var(--border)' }}>
        <input
          className="field"
          placeholder="Lọc theo tên…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ padding: '3px 7px', fontSize: 11 }}
        />
      </div>

      {/* Column header */}
      <div className="fb-row fb-head">
        <span className="fb-c-name">Tên</span>
        <span className="fb-c-size">Kích thước</span>
        <span className="fb-c-date">Sửa đổi</span>
      </div>

      {/* Listing (focusable for keyboard nav; drag = rubber-band select) */}
      <div
        ref={listRef}
        tabIndex={0}
        onKeyDown={onListKeyDown}
        style={{ flex: 1, overflow: 'auto', minHeight: 0, outline: 'none', position: 'relative' }}
        onMouseDown={onListMouseDown}
        onMouseMove={onListMouseMove}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {marquee && marquee.height > 2 && (
          <div className="fb-marquee" style={{ top: marquee.top, height: marquee.height }} />
        )}
        {error && <div style={{ padding: 12, color: 'var(--danger)', font: '400 11px var(--font-mono)' }}>{error}</div>}
        {loading && !entries.length && (
          <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 11 }}>Đang tải…</div>
        )}
        {!error && !loading && !visible.length && (
          <div style={{ padding: 12, color: 'var(--text-faint)', fontSize: 11 }}>Thư mục trống.</div>
        )}
        {path && (
          <div className="fb-row fb-item" onDoubleClick={goParent}>
            <span className="fb-c-name">
              <span className="fb-ico">📁</span>..
            </span>
            <span className="fb-c-size" />
            <span className="fb-c-date" />
          </div>
        )}
        {visible.map((e, i) => (
          <div
            key={e.name}
            data-idx={i}
            className={`fb-row fb-item${selected.has(e.name) ? ' sel' : ''}`}
            onDoubleClick={() => openEntry(e)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              if (!selected.has(e.name)) {
                selectOnly(e.name);
                anchorRef.current = i;
              }
              setMenu({ x: ev.clientX, y: ev.clientY, entry: e });
            }}
          >
            <span className="fb-c-name" title={e.name}>
              <span className="fb-ico">{e.isDir ? '📁' : '📄'}</span>
              {e.name}
            </span>
            <span className="fb-c-size">{fmtSize(e.size, e.isDir)}</span>
            <span className="fb-c-date">{fmtDate(e.modified)}</span>
          </div>
        ))}
      </div>

      {/* Footer: transfer button + selection count */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 8px',
          borderTop: '1px solid var(--border-2)',
          background: 'var(--surface-2)',
        }}
      >
        <button
          className="fb-transfer"
          disabled={!selected.size}
          onClick={() => onTransfer(selectedEntries(), path)}
        >
          {transferLabel}
        </button>
        {onSync && (
          <button
            className="fb-sync-btn"
            title="Đồng bộ toàn bộ thư mục này (mirror — cần xác nhận)"
            onClick={onSync}
          >
            {syncLabel ?? '⟳ Đồng bộ'}
          </button>
        )}
        <span style={{ marginLeft: 'auto', font: '400 10px var(--font-mono)', color: 'var(--text-muted)' }}>
          {selected.size ? `${selected.size} đã chọn` : `${visible.length} mục`}
        </span>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menuItems()} />
      )}

      {confirmDel && (
        <DeleteConfirm
          list={confirmDel}
          onCancel={() => setConfirmDel(null)}
          onConfirm={() => performRemove(confirmDel)}
        />
      )}
    </div>
  );
}

/** Styled "are you sure" popup for Delete (overlays the panel it belongs to). */
function DeleteConfirm({
  list,
  onCancel,
  onConfirm,
}: {
  list: FileEntry[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dirs = list.filter((e) => e.isDir).length;
  const files = list.length - dirs;
  const parts: string[] = [];
  if (files) parts.push(`${files} tệp`);
  if (dirs) parts.push(`${dirs} thư mục`);
  const what =
    list.length === 1 ? `"${list[0].name}"` : parts.join(' và ');
  return (
    <div
      onMouseDown={onCancel}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(5,7,10,0.55)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 45,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 320,
          background: 'var(--surface-2)',
          border: '1px solid var(--border-3)',
          borderRadius: 12,
          boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
          padding: 20,
        }}
      >
        <div style={{ font: '600 14px var(--font-ui)', color: 'var(--text)', marginBottom: 6 }}>
          Xác nhận xóa
        </div>
        <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)', marginBottom: 16, lineHeight: 1.5 }}>
          Bạn có chắc chắn muốn xóa {what}? Tệp và thư mục sẽ bị xóa vĩnh viễn, không thể hoàn tác.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="ghost-btn"
            style={{ flex: 1, height: 36, justifyContent: 'center' }}
            onClick={onCancel}
          >
            Hủy
          </button>
          <button
            style={{
              flex: 1,
              height: 36,
              justifyContent: 'center',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 12px',
              borderRadius: 7,
              border: 'none',
              background: 'var(--danger)',
              color: '#fff',
              font: '600 12px var(--font-ui)',
              cursor: 'pointer',
            }}
            onClick={onConfirm}
          >
            Xóa vĩnh viễn
          </button>
        </div>
      </div>
    </div>
  );
}
