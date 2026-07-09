import { useEffect, useRef, useState, useCallback } from 'react';
import type { FileEntry, StatInfo } from '../ipc/ssh';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { PropertiesDialog } from './PropertiesDialog';
import { joinPath } from './pathUtils';
import { useStore } from '../state/store';
import { copyText } from '../ipc/clipboard';
import {
  IconParent,
  IconRefresh,
  IconNewFolder,
  IconSearch,
  IconFolder,
  IconFile,
  IconSymlink,
  IconArrowRight,
  IconArrowLeft,
} from './icons';
import { useT } from '../i18n';

export interface FsBackend {
  list: (path: string) => Promise<FileEntry[]>;
  mkdir: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string, isDir: boolean) => Promise<void>;
  /** Change permission bits (remote SFTP only; absent for local). */
  chmod?: (path: string, mode: number) => Promise<void>;
  /** Recursive search from a root (remote SFTP only; absent for local). */
  search?: (root: string, query: string) => Promise<Array<{ path: string; name: string; isDir: boolean }>>;
  /** Resolve the home directory, so "~" works in the path bar. */
  home?: () => Promise<string>;
  /** Create a new empty file (errors if the name exists). */
  touch: (path: string) => Promise<void>;
  /** Full metadata for the Properties dialog. */
  stat?: (path: string) => Promise<StatInfo>;
  /** Recursive size of a directory (bounded). */
  dirSize?: (path: string) => Promise<number>;
  /** Cancel an in-flight dirSize for this pane (remote only; absent for local — a local walk holds no shared lock). */
  dirSizeCancel?: () => void;
  /** Path separator + join, so local (\\) and remote (/) behave correctly. */
  sep: string;
}

/** Row icon: symlink / folder (blue) / file (muted) — flat + color-coded. */
function EntryIcon({ isDir, isSymlink }: { isDir: boolean; isSymlink?: boolean }) {
  if (isSymlink) return <IconSymlink size={14} color="var(--sh-wsl)" />;
  if (isDir) return <IconFolder size={14} color="var(--sh-ps)" />;
  return <IconFile size={14} color="var(--text-muted)" />;
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
  transferDir,
  onTransfer,
  onPathChange,
  refreshKey,
  syncLabel,
  onSync,
  onEditFile,
  onOpenFile,
  onCut,
  onCopy,
  onPaste,
  canPaste,
  cutMarks,
}: {
  title: string;
  backend: FsBackend;
  initialPath: string;
  accent: string;
  /** Plain-text transfer action label (e.g. "Tải lên"); used in button + menu. */
  transferLabel: string;
  /** Direction of the transfer, for the button's arrow icon. */
  transferDir?: 'right' | 'left';
  onTransfer: (entries: FileEntry[], fromPath: string) => void;
  /** Called whenever this panel's current directory changes (transfer destination). */
  onPathChange?: (path: string) => void;
  /** Bump to force a re-list (e.g. after a transfer completes on the other side). */
  refreshKey?: number;
  /** Optional "sync this whole directory" action, shown next to the transfer button. */
  syncLabel?: string;
  onSync?: () => void;
  /** Open a file for editing (app = specific exe; undefined = default-editor resolution). */
  onEditFile?: (entry: FileEntry, dir: string, app?: string) => void;
  /** Open a file with the platform handler (double-click / menu "Open"). */
  onOpenFile?: (entry: FileEntry, dir: string) => void;
  onCut?: (entries: FileEntry[], dir: string) => void;
  onCopy?: (entries: FileEntry[], dir: string) => void;
  onPaste?: (dir: string) => void;
  canPaste?: boolean;
  /** Entries rendered dimmed (they're on the clipboard as a cut). */
  cutMarks?: { dir: string; names: string[] } | null;
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
  // Inline rename: which entry is being edited + its draft name.
  const [renaming, setRenaming] = useState<{ name: string; draft: string } | null>(null);
  // Transient error banner (webview alert() is unreliable, so we render our own).
  const [notice, setNotice] = useState<string | null>(null);
  // In-panel text prompt (WKWebView's window.prompt returns null, so mkdir/chmod
  // need their own input). Holds the label, current draft and the submit action.
  const [ask, setAsk] = useState<{ label: string; draft: string; onOk: (v: string) => void } | null>(null);
  const [propsFor, setPropsFor] = useState<FileEntry | null>(null);
  const [marquee, setMarquee] = useState<{ top: number; height: number } | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<
    Array<{ path: string; name: string; isDir: boolean }> | null
  >(null);
  const t = useT();
  const defaultEditor = useStore((s) => s.settings.defaultEditor);
  const editors = useStore((s) => s.settings.editors);
  const updateSettings = useStore((s) => s.updateSettings);

  const runSearch = async (q: string) => {
    if (!backend.search || !q.trim()) return;
    setSearchResults(null);
    try {
      setSearchResults(await backend.search(path, q.trim()));
    } catch {
      setSearchResults([]);
    }
  };
  const dirOf = (p: string) => {
    const i = p.lastIndexOf(backend.sep);
    return i <= 0 ? (backend.sep === '\\' ? '' : '/') : p.slice(0, i);
  };

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

  // Auto-dismiss the error banner.
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(id);
  }, [notice]);

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
  // Typed path: expand a leading "~" to the home directory (local or remote).
  const goTyped = async (raw: string) => {
    let p = raw.trim();
    if (backend.home && (p === '~' || p.startsWith('~/') || p.startsWith('~\\'))) {
      const home = await backend.home().catch(() => '');
      if (home) {
        const rest = p.slice(2);
        p = rest ? joinPath(home, rest, backend.sep) : home;
      }
    }
    go(p);
  };
  const goParent = () => go(joinPath(path, '..', backend.sep));
  const openEntry = (e: FileEntry) => {
    if (e.isDir) go(joinPath(path, e.name, backend.sep));
    else onOpenFile?.(e, path);
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
    if (renaming) return; // the inline input handles its own keys
    // Ctrl/Cmd+A = select every visible entry.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      setSelected(new Set(visible.map((v) => v.name)));
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X')) {
      e.preventDefault();
      const sel = selectedEntries();
      if (sel.length) onCut?.(sel, path);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      const sel = selectedEntries();
      if (sel.length) onCopy?.(sel, path);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      if (canPaste) onPaste?.(path);
      return;
    }
    // F2 = rename the focused entry (or the only selected one).
    if (e.key === 'F2') {
      e.preventDefault();
      const cur =
        anchorRef.current >= 0
          ? visible[anchorRef.current]
          : selected.size === 1
            ? visible.find((v) => selected.has(v.name))
            : undefined;
      if (cur) startRename(cur);
      return;
    }
    // Ctrl/Cmd+Backspace = delete selected (like Delete). Plain Backspace = parent.
    if ((e.ctrlKey || e.metaKey) && e.key === 'Backspace') {
      e.preventDefault();
      const sel = selectedEntries();
      if (sel.length) setConfirmDel(sel);
      return;
    }
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
  const isCutDim = (name: string) =>
    !!cutMarks && cutMarks.dir === path && cutMarks.names.includes(name);

  const doMkdir = () => {
    setMenu(null);
    setAsk({
      label: t('fb.promptNewFolder'),
      draft: '',
      onOk: async (name) => {
        if (!name.trim()) return;
        try {
          await backend.mkdir(joinPath(path, name.trim(), backend.sep));
          await load(path);
        } catch (e) {
          setNotice(t('fb.errMkdir', { err: String(e) }));
        }
      },
    });
  };
  const doNewFile = () => {
    setMenu(null);
    setAsk({
      label: t('fb.promptNewFile'),
      draft: '',
      onOk: async (name) => {
        if (!name.trim()) return;
        try {
          await backend.touch(joinPath(path, name.trim(), backend.sep));
          await load(path);
        } catch (e) {
          setNotice(t('fb.errNewFile', { err: String(e) }));
        }
      },
    });
  };
  // Start inline rename (F2 or context menu). The row renders an input.
  const startRename = (entry: FileEntry) => {
    setMenu(null);
    setRenaming({ name: entry.name, draft: entry.name });
  };
  const commitRename = async () => {
    const r = renaming;
    if (!r) return;
    setRenaming(null);
    const next = r.draft.trim();
    if (!next || next === r.name) return;
    try {
      await backend.rename(joinPath(path, r.name, backend.sep), joinPath(path, next, backend.sep));
      await load(path);
    } catch (e) {
      setNotice(t('fb.errRename', { err: String(e) }));
    }
  };
  const doChmod = (entry: FileEntry) => {
    if (!backend.chmod) return;
    setMenu(null);
    const cur = (entry.mode & 0o777).toString(8).padStart(3, '0');
    setAsk({
      label: t('fb.chmodPrompt'),
      draft: cur,
      onOk: async (input) => {
        const mode = parseInt(input.trim(), 8);
        if (Number.isNaN(mode)) return;
        try {
          await backend.chmod!(joinPath(path, entry.name, backend.sep), mode);
          await load(path);
        } catch (e) {
          setNotice(t('fb.errChmod', { err: String(e) }));
        }
      },
    });
  };
  // Actual deletion — the confirm popup gates this.
  const performRemove = async (list: FileEntry[]) => {
    setConfirmDel(null);
    if (!list.length) return;
    try {
      for (const e of list) await backend.remove(joinPath(path, e.name, backend.sep), e.isDir);
      void load(path);
    } catch (e) {
      setNotice(t('fb.errRemove', { err: String(e) }));
    }
  };

  const menuItems = (): MenuItem[] => {
    const sel = selectedEntries();
    const target = menu?.entry;
    const list = target && !selected.has(target.name) ? [target] : sel;
    const isFile = !!target && !target.isDir;
    const fullOf = (e: FileEntry) => joinPath(path, e.name, backend.sep);
    return [
      { label: transferLabel, disabled: list.length === 0, onClick: () => onTransfer(list, path) },
      { label: t('fb.open'), disabled: !target, onClick: () => target && openEntry(target) },
      {
        label: t('fb.edit'),
        disabled: !isFile || !onEditFile,
        onClick: () => target && onEditFile?.(target, path, defaultEditor || undefined),
      },
      {
        label: t('fb.editWith'),
        disabled: !isFile || !onEditFile,
        children: [
          ...editors.map((ed) => ({
            label: ed.name,
            onClick: () => target && onEditFile?.(target, path, ed.path),
          })),
          ...(editors.length ? [{ label: '', separator: true }] : []),
          {
            label: t('fb.editBrowse'),
            onClick: async () => {
              const { open } = await import('@tauri-apps/plugin-dialog');
              const p = await open({ multiple: false });
              if (typeof p !== 'string' || !target) return;
              const base = p.split(/[\\/]/).pop() ?? p;
              const dot = base.lastIndexOf('.');
              const name = dot > 0 ? base.slice(0, dot) : base;
              const cur = useStore.getState().settings.editors;
              if (!cur.some((e) => e.path === p)) updateSettings({ editors: [...cur, { name, path: p }] });
              onEditFile?.(target, path, p);
            },
          },
        ],
      },
      { label: '', separator: true },
      { label: t('fb.cut'), disabled: list.length === 0 || !onCut, onClick: () => onCut?.(list, path) },
      { label: t('fb.copy'), disabled: list.length === 0 || !onCopy, onClick: () => onCopy?.(list, path) },
      { label: t('fb.paste'), disabled: !canPaste || !onPaste, onClick: () => onPaste?.(path) },
      { label: t('fb.rename'), disabled: !target, onClick: () => target && startRename(target) },
      {
        label: t('fb.delete'),
        danger: true,
        disabled: list.length === 0,
        onClick: () => list.length && setConfirmDel(list),
      },
      { label: '', separator: true },
      { label: t('fb.newFile'), onClick: doNewFile },
      { label: t('fb.newFolder'), onClick: doMkdir },
      { label: '', separator: true },
      {
        label: t('fb.copyPath'),
        disabled: !target,
        onClick: () => target && void copyText(fullOf(target)),
      },
      ...(backend.chmod
        ? [{ label: t('fb.chmod'), disabled: !target, onClick: () => target && doChmod(target) }]
        : []),
      { label: t('fb.properties'), disabled: !target, onClick: () => target && (setMenu(null), setPropsFor(target)) },
      { label: '', separator: true },
      {
        label: t('fb.selectAll'),
        disabled: visible.length === 0,
        onClick: () => setSelected(new Set(visible.map((v) => v.name))),
      },
      { label: t('fb.refresh'), onClick: () => load(path) },
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
          <button className="fb-tool" title={t('fb.toParent')} onClick={goParent}>
            <IconParent size={15} />
          </button>
          <button className="fb-tool" title={t('fb.refresh')} onClick={() => load(path)}>
            <IconRefresh size={14} />
          </button>
          <button className="fb-tool" title={t('fb.newFolder')} onClick={doMkdir}>
            <IconNewFolder size={14} />
          </button>
          {backend.search && (
            <button
              className={`fb-tool${searching ? ' on' : ''}`}
              title={searching ? t('fb.searchClose') : t('fb.searchBtn')}
              onClick={() => {
                setSearching((v) => !v);
                setSearchResults(null);
                setSearchQuery('');
              }}
            >
              <IconSearch size={14} />
            </button>
          )}
        </div>
      </div>

      {searching && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
          <input
            autoFocus
            className="field"
            placeholder={t('fb.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void runSearch(searchQuery)}
            style={{ padding: '4px 8px', fontSize: 11.5 }}
          />
          {searchResults && (
            <span style={{ font: '400 10px var(--font-mono)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
              {t('fb.searchResults', { n: searchResults.length })}
            </span>
          )}
        </div>
      )}

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
                void goTyped(pathDraft);
              }
              if (e.key === 'Escape') setEditingPath(false);
            }}
            style={{ padding: '3px 7px', fontSize: 11 }}
          />
        ) : (
          <div
            className="fb-path"
            title={t('fb.editPath')}
            onClick={() => {
              setPathDraft(path);
              setEditingPath(true);
            }}
          >
            {path || t('fb.rootPick')}
          </div>
        )}
      </div>

      {/* Filter */}
      <div style={{ padding: '5px 8px', borderBottom: '1px solid var(--border)' }}>
        <input
          className="field"
          placeholder={t('fb.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ padding: '3px 7px', fontSize: 11 }}
        />
      </div>

      {/* Column header */}
      <div className="fb-row fb-head">
        <span className="fb-c-name">{t('fb.colName')}</span>
        <span className="fb-c-size">{t('fb.colSize')}</span>
        <span className="fb-c-date">{t('fb.colDate')}</span>
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
        {marquee && marquee.height > 2 && !searching && (
          <div className="fb-marquee" style={{ top: marquee.top, height: marquee.height }} />
        )}
        {searching && (
          <>
            {searchResults === null && searchQuery.trim() && (
              <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 11 }}>{t('fb.searching')}</div>
            )}
            {searchResults?.length === 0 && (
              <div style={{ padding: 12, color: 'var(--text-faint)', fontSize: 11 }}>{t('fb.searchNone')}</div>
            )}
            {searchResults?.map((r) => (
              <div
                key={r.path}
                className="fb-row fb-item"
                title={r.path}
                onDoubleClick={() => {
                  setSearching(false);
                  go(dirOf(r.path));
                }}
              >
                <span className="fb-c-name">
                  <span className="fb-ico">
                    <EntryIcon isDir={r.isDir} />
                  </span>
                  {r.name}
                </span>
                <span
                  className="fb-c-date"
                  style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {dirOf(r.path)}
                </span>
              </div>
            ))}
          </>
        )}
        {!searching && (
          <>
        {error && <div style={{ padding: 12, color: 'var(--danger)', font: '400 11px var(--font-mono)' }}>{error}</div>}
        {loading && !entries.length && (
          <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 11 }}>{t('fb.loading')}</div>
        )}
        {!error && !loading && !visible.length && (
          <div style={{ padding: 12, color: 'var(--text-faint)', fontSize: 11 }}>{t('fb.emptyDir')}</div>
        )}
        {path && (
          <div className="fb-row fb-item" onDoubleClick={goParent}>
            <span className="fb-c-name">
              <span className="fb-ico">
                <IconFolder size={14} color="var(--sh-ps)" />
              </span>
              ..
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
            style={isCutDim(e.name) ? { opacity: 0.45 } : undefined}
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
            <span className="fb-c-name" title={e.perms ? `${e.perms}  ${e.name}` : e.name}>
              <span className="fb-ico">
                <EntryIcon isDir={e.isDir} isSymlink={e.isSymlink} />
              </span>
              {renaming?.name === e.name ? (
                <input
                  autoFocus
                  className="field mono"
                  value={renaming.draft}
                  onChange={(ev) => setRenaming({ name: e.name, draft: ev.target.value })}
                  onMouseDown={(ev) => ev.stopPropagation()}
                  onDoubleClick={(ev) => ev.stopPropagation()}
                  onKeyDown={(ev) => {
                    ev.stopPropagation();
                    if (ev.key === 'Enter') {
                      ev.preventDefault();
                      void commitRename();
                    } else if (ev.key === 'Escape') {
                      ev.preventDefault();
                      setRenaming(null);
                    }
                  }}
                  onBlur={() => void commitRename()}
                  onFocus={(ev) => {
                    // Preselect the base name (keep the extension) for quick edits.
                    const dot = e.name.lastIndexOf('.');
                    if (!e.isDir && dot > 0) ev.target.setSelectionRange(0, dot);
                    else ev.target.select();
                  }}
                  style={{ padding: '1px 5px', fontSize: 11, flex: 1, minWidth: 0 }}
                />
              ) : (
                e.name
              )}
            </span>
            <span className="fb-c-size">{fmtSize(e.size, e.isDir)}</span>
            <span className="fb-c-date">{fmtDate(e.modified)}</span>
          </div>
        ))}
          </>
        )}
      </div>

      {notice && (
        <div
          onClick={() => setNotice(null)}
          title={notice}
          style={{
            padding: '5px 8px',
            borderTop: '1px solid var(--border-2)',
            background: 'color-mix(in srgb, var(--danger) 18%, var(--surface-2))',
            color: 'var(--danger)',
            font: '400 10.5px var(--font-mono)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            cursor: 'pointer',
          }}
        >
          {notice}
        </div>
      )}

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
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
        >
          {transferDir === 'left' && <IconArrowLeft size={13} />}
          {transferLabel}
          {transferDir === 'right' && <IconArrowRight size={13} />}
        </button>
        {onSync && (
          <button
            className="fb-sync-btn"
            title="Đồng bộ toàn bộ thư mục này (mirror — cần xác nhận)"
            onClick={onSync}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
          >
            <IconRefresh size={13} />
            {syncLabel ?? t('fb.verbSync')}
          </button>
        )}
        <span style={{ marginLeft: 'auto', font: '400 10px var(--font-mono)', color: 'var(--text-muted)' }}>
          {selected.size ? t('fb.selected', { n: selected.size }) : t('fb.itemCount', { n: visible.length })}
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

      {ask && (
        <PromptDialog
          label={ask.label}
          initial={ask.draft}
          onCancel={() => setAsk(null)}
          onConfirm={(v) => {
            setAsk(null);
            ask.onOk(v);
          }}
        />
      )}

      {propsFor && (
        <PropertiesDialog
          entry={propsFor}
          dir={path}
          backend={backend}
          onClose={() => setPropsFor(null)}
          onChanged={() => void load(path)}
        />
      )}
    </div>
  );
}

/** Small in-panel text prompt (replaces window.prompt, unavailable in WKWebView). */
function PromptDialog({
  label,
  initial,
  onCancel,
  onConfirm,
}: {
  label: string;
  initial: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}) {
  const t = useT();
  const [val, setVal] = useState(initial);
  return (
    <div
      onMouseDown={onCancel}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(5,7,10,0.55)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 46,
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
        <div style={{ font: '600 12.5px var(--font-ui)', color: 'var(--text)', marginBottom: 10 }}>
          {label}
        </div>
        <input
          autoFocus
          className="field mono"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onConfirm(val);
            }
            if (e.key === 'Escape') onCancel();
          }}
          style={{ padding: '6px 9px', fontSize: 12, width: '100%' }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            className="ghost-btn"
            style={{ flex: 1, height: 36, justifyContent: 'center' }}
            onClick={onCancel}
          >
            {t('common.cancel')}
          </button>
          <button
            className="accent-btn"
            style={{ flex: 1, height: 36, justifyContent: 'center' }}
            onClick={() => onConfirm(val)}
          >
            {t('common.ok')}
          </button>
        </div>
      </div>
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
  const t = useT();
  const dirs = list.filter((e) => e.isDir).length;
  const files = list.length - dirs;
  const parts: string[] = [];
  if (files) parts.push(t('fb.delFiles', { n: files }));
  if (dirs) parts.push(t('fb.delDirs', { n: dirs }));
  const what = list.length === 1 ? `"${list[0].name}"` : parts.join(' + ');
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
          {t('fb.delTitle')}
        </div>
        <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)', marginBottom: 16, lineHeight: 1.5 }}>
          {t('fb.delMsg', { what })}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="ghost-btn"
            style={{ flex: 1, height: 36, justifyContent: 'center' }}
            onClick={onCancel}
          >
            {t('common.cancel')}
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
            {t('fb.delConfirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
