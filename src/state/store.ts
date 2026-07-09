import { create } from 'zustand';
import type {
  LayoutPreset,
  LayoutMode,
  Pane,
  PaneKind,
  PaneStatus,
  PersistedState,
  Project,
  Settings,
  ShellInfo,
  ShellKind,
  Snapshot,
  SshConfig,
  Tab,
  TabItem,
} from '../types';
import { LAYOUTS, resolveLayout } from '../layouts';
import { loadPersisted, savePersisted } from '../ipc/persist';
import { killSession } from '../ipc/session';
import { secretCopy, secretDelete } from '../ipc/ssh';
import { isPaneActive } from './activity';
import { IS_WIN, SHELL_ORDER } from '../shells';
import { translate } from '../i18n';
import type { ClaudeSession } from '../ipc/claude';

const uid = () =>
  Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

const DEFAULT_SETTINGS: Settings = {
  restoreOnStartup: true,
  restoreCwd: true,
  restoreGrid: true,
  autoRunCommand: false,
  defaultLayout: 'grid2x2',
  shellPaths: {},
  sidebarVisible: true,
  fontSize: 'medium',
  uiScale: 1,
  githubRepo: '',
  language: 'en',
  defaultEditor: '',
  editors: [],
};

const STORE_VERSION = 4;
const MAX_SNAPSHOTS = 12;

interface RuntimeInfo {
  status: PaneStatus;
  exitCode?: number;
  /** Why the process failed/ended abnormally, shown on the exited overlay. */
  exitError?: string;
  nonce: number;
  runOnSpawn: boolean;
  /** When the current process started (ms epoch) — for uptime. */
  startedAt: number;
}

export interface PaneStat {
  cpu: number;
  mem: number;
  /** True when Claude Code is running inside this pane. */
  claude: boolean;
  /** True when Claude is actively working (recent PTY output), false = idle. */
  busy: boolean;
}

export interface NewPaneInput {
  name: string;
  shell: ShellKind;
  cwd: string;
  presetCommand?: string;
  autoStart: boolean;
  projectId?: string;
  slot?: number;
  kind?: PaneKind;
  ssh?: SshConfig;
  /** Pre-generated id, so the caller can attach a secret before the pane mounts. */
  id?: string;
  /** One-shot temp terminal: never persisted, auto-removed when it stops. */
  ephemeral?: boolean;
}

interface AppState {
  tabs: Tab[];
  /** All terminals (the sidebar list). Each runs in the background regardless of tabs. */
  panes: Pane[];
  projects: Project[];
  activeTabId: string;
  settings: Settings;
  snapshots: Snapshot[];
  /** Private-key files picked before, newest first (for the key auth dropdown). */
  recentKeys: string[];

  runtime: Record<string, RuntimeInfo>;
  /** Live CPU%/memory per pane (from the Rust sampler; not persisted). */
  stats: Record<string, PaneStat>;
  /** Live Claude Code session state per pane (from the JSONL reader; not persisted). */
  claudeSessions: Record<string, ClaudeSession>;
  /** Live SSH connection health per pane ('reconnecting' while dropped); not persisted. */
  sshStatus: Record<string, { state: string; attempt: number }>;
  focusedPaneId: string | null;
  shells: ShellInfo[];
  ui: {
    addCmdOpen: boolean;
    addCmdSlot: number | null;
    settingsOpen: boolean;
    /** Section to open the settings window on (e.g. 'projects'); null = default. */
    settingsSection: string | null;
    editPaneId: string | null;
  };
  hydrated: boolean;
  savedAt: number | null;

  hydrate: () => Promise<void>;
  setShells: (s: ShellInfo[]) => void;
  setStats: (list: Array<{ paneId: string; cpu: number; mem: number; claude: boolean }>) => void;
  setClaudeSessions: (map: Record<string, ClaudeSession>) => void;
  setSshStatus: (paneId: string, state: string, attempt: number) => void;

  addTab: () => void;
  closeTab: (id: string) => void;
  renameTab: (id: string, name: string) => void;
  setActiveTab: (id: string) => void;
  setLayout: (preset: LayoutMode) => void;
  reorderTab: (dragId: string, targetId: string) => void;
  togglePinTab: (id: string) => void;

  /** Returns the new pane's id (so callers can attach secrets to it). */
  addPane: (input: NewPaneInput) => string;
  /** Open a one-shot temp terminal (default shell, home dir) — see Pane.ephemeral. */
  addTempPane: () => void;
  /** Open an SFTP file browser for an SSH pane, reusing its config + secret.
   *  Focuses the existing browser pane for the same host/user if one exists. */
  openSftpForPane: (paneId: string) => void;
  /** Show an existing cmd in the active tab (restarts it if stopped). */
  showPaneInTab: (paneId: string, slot?: number) => void;
  /** Hide a cmd from the active tab (process keeps running). */
  removeFromTab: (paneId: string) => void;
  /** Move a cmd to a specific slot in the active tab (swaps if occupied). */
  movePaneToSlot: (paneId: string, slot: number) => void;
  /** Stop a cmd's process but keep the cmd (Tắt). */
  stopPane: (paneId: string) => void;
  /** Stop every running terminal's process; the cmds stay in the list. */
  stopAllPanes: () => void;
  /** Stop every running (non-browser) terminal matching `pred`. */
  stopPanesWhere: (pred: (p: Pane) => boolean) => void;
  /** Delete a cmd everywhere and kill its process (Xóa). */
  removePane: (paneId: string) => void;
  renamePane: (paneId: string, name: string) => void;
  updatePane: (paneId: string, patch: Partial<Pane>) => void;
  /** Persist a browser pane's current directory (per side) so it restores on reopen. */
  setBrowserPath: (paneId: string, side: 'local' | 'remote', path: string) => void;
  restartPane: (paneId: string) => void;
  togglePinPane: (paneId: string) => void;
  setPaneStatus: (paneId: string, status: PaneStatus, exitCode?: number, exitError?: string) => void;
  consumeRunOnSpawn: (paneId: string) => boolean;
  setFocusedPane: (paneId: string | null) => void;

  updateSettings: (patch: Partial<Settings>) => void;
  toggleSidebar: () => void;

  addProject: (name: string, path?: string) => string;
  updateProject: (id: string, patch: Partial<Project>) => void;
  removeProject: (id: string) => void;

  captureSnapshot: () => void;
  restoreSnapshot: (at: number) => void;

  /** Remember a private-key file path (moves it to the front). */
  rememberKey: (path: string) => void;
  /** Drop a key path from the remembered list. */
  forgetKey: (path: string) => void;

  exportData: () => string;
  importData: (json: string) => boolean;

  openAddCmd: (slot?: number | null) => void;
  closeAddCmd: () => void;
  openEditCmd: (paneId: string) => void;
  closeEditCmd: () => void;
  openSettings: (section?: string) => void;
  closeSettings: () => void;
}

function freshTab(layout: LayoutMode, name = 'Tab mới'): Tab {
  return { id: uid(), name, layout, pinned: false, items: [] };
}

/** Items a tab actually displays = its own references + every pinned cmd. */
export function displayItems(tab: Tab, panes: Pane[]): TabItem[] {
  const byId = new Map(panes.map((p) => [p.id, p]));
  const items = tab.items.filter((it) => byId.has(it.paneId));
  const present = new Set(items.map((i) => i.paneId));
  const used = new Set(items.map((i) => i.slot));
  const extra: TabItem[] = [];
  let next = 0;
  for (const p of panes) {
    if (p.pinned && !present.has(p.id)) {
      while (used.has(next)) next++;
      used.add(next);
      extra.push({ paneId: p.id, slot: next });
    }
  }
  return [...items, ...extra];
}

function firstEmptySlot(items: TabItem[], layout: LayoutPreset): number {
  const cap = LAYOUTS[layout].capacity;
  const used = new Set(items.map((i) => i.slot));
  for (let i = 0; i < cap; i++) if (!used.has(i)) return i;
  return -1;
}

function buildRuntime(panes: Pane[], runOnSpawn: boolean): Record<string, RuntimeInfo> {
  const rt: Record<string, RuntimeInfo> = {};
  const now = Date.now();
  for (const p of panes)
    rt[p.id] = {
      // Panes with "reopen automatically" off restore stopped — no process is
      // spawned until the user starts them (saves CPU/RAM on app start).
      status: p.autoStart === false ? 'exited' : 'running',
      nonce: 0,
      runOnSpawn: runOnSpawn && !!p.presetCommand,
      startedAt: now,
    };
  return rt;
}

/** Strip temp terminals (and their tab references) from anything that gets saved. */
function withoutEphemeral(tabs: Tab[], panes: Pane[]): { tabs: Tab[]; panes: Pane[] } {
  const ids = new Set(panes.filter((p) => p.ephemeral).map((p) => p.id));
  if (ids.size === 0) return { tabs, panes };
  return {
    tabs: tabs.map((t) => ({ ...t, items: t.items.filter((i) => !ids.has(i.paneId)) })),
    panes: panes.filter((p) => !p.ephemeral),
  };
}

// ---- debounced persistence ----
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(get: () => AppState) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = get();
    const { tabs, panes } = withoutEphemeral(s.tabs, s.panes);
    const persisted: PersistedState = {
      version: STORE_VERSION,
      tabs,
      panes,
      projects: s.projects,
      activeTabId: s.activeTabId,
      settings: s.settings,
      snapshots: s.snapshots,
      recentKeys: s.recentKeys,
    };
    void savePersisted(persisted).then(() => useStore.setState({ savedAt: Date.now() }));
  }, 400);
}

export const useStore = create<AppState>((set, get) => {
  const commit = (partial: Partial<AppState>) => {
    set(partial);
    scheduleSave(get);
  };

  /** Add a reference to `paneId` in the active tab at a free slot. */
  const referenceInActive = (paneId: string, slot?: number) => {
    const { panes, tabs, activeTabId } = get();
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab || tab.items.some((i) => i.paneId === paneId)) return;
    const shown = displayItems(tab, panes);
    const eff = resolveLayout(tab.layout, shown.length + 1); // concrete preset for slots
    const nextLayout = tab.layout === 'auto' ? 'auto' : eff; // keep auto sticky
    let s = slot ?? -1;
    const used = new Set(shown.map((i) => i.slot));
    if (s < 0 || s >= LAYOUTS[eff].capacity || used.has(s)) s = firstEmptySlot(shown, eff);
    if (s < 0) s = shown.length;
    commit({
      tabs: tabs.map((t) =>
        t.id === activeTabId ? { ...t, layout: nextLayout, items: [...t.items, { paneId, slot: s }] } : t
      ),
      focusedPaneId: paneId,
    });
  };

  return {
    tabs: [freshTab('grid2x2', 'Tab 1')],
    panes: [],
    projects: [],
    activeTabId: '',
    settings: DEFAULT_SETTINGS,
    snapshots: [],
    recentKeys: [],
    runtime: {},
    stats: {},
    claudeSessions: {},
    sshStatus: {},
    focusedPaneId: null,
    shells: [],
    ui: { addCmdOpen: false, addCmdSlot: null, settingsOpen: false, settingsSection: null, editPaneId: null },
    hydrated: false,
    savedAt: null,

    hydrate: async () => {
      const p = await loadPersisted();
      const settings: Settings = { ...DEFAULT_SETTINGS, ...(p?.settings ?? {}) };
      const snapshots = p?.snapshots ?? [];
      const projects = p?.projects ?? [];
      const recentKeys = p?.recentKeys ?? [];

      if (!p || p.version !== STORE_VERSION || !settings.restoreOnStartup) {
        const t = freshTab(settings.defaultLayout, 'Tab 1');
        set({
          tabs: [t],
          panes: [],
          projects,
          activeTabId: t.id,
          settings,
          snapshots,
          recentKeys,
          runtime: {},
          hydrated: true,
        });
        return;
      }

      const panes: Pane[] = (p.panes ?? []).map((pn) => ({
        ...pn,
        cwd: settings.restoreCwd ? pn.cwd : '',
      }));
      const paneIds = new Set(panes.map((x) => x.id));
      const tabs: Tab[] = (p.tabs?.length ? p.tabs : [freshTab(settings.defaultLayout, 'Tab 1')]).map(
        (t) => ({
          id: t.id,
          name: t.name,
          layout: settings.restoreGrid ? t.layout : settings.defaultLayout,
          pinned: t.pinned ?? false,
          items: (t.items ?? []).filter((it) => paneIds.has(it.paneId)),
        })
      );
      const activeTabId = tabs.some((t) => t.id === p.activeTabId) ? p.activeTabId : tabs[0].id;

      set({
        tabs,
        panes,
        projects,
        activeTabId,
        settings,
        snapshots,
        recentKeys,
        runtime: buildRuntime(panes, settings.autoRunCommand),
        hydrated: true,
      });
    },

    setShells: (shells) => set({ shells }),

    setStats: (list) => {
      const now = Date.now();
      const next: Record<string, PaneStat> = {};
      for (const s of list)
        next[s.paneId] = {
          cpu: s.cpu,
          mem: s.mem,
          claude: !!s.claude,
          busy: !!s.claude && isPaneActive(s.paneId, now),
        };
      set({ stats: next });
    },

    setClaudeSessions: (map) => set({ claudeSessions: map }),

    setSshStatus: (paneId, state, attempt) =>
      set({ sshStatus: { ...get().sshStatus, [paneId]: { state, attempt } } }),

    addTab: () => {
      const t = freshTab(
        get().settings.defaultLayout,
        translate(get().settings.language, 'default.tabName')
      );
      commit({ tabs: [...get().tabs, t], activeTabId: t.id });
    },

    // Closing a tab removes a display view; cmds keep running (managed in sidebar).
    closeTab: (id) => {
      const { tabs, activeTabId } = get();
      let next = tabs.filter((t) => t.id !== id);
      if (next.length === 0) next = [freshTab(get().settings.defaultLayout, 'Tab 1')];
      const nextActive = activeTabId === id ? next[0].id : activeTabId;
      commit({ tabs: next, activeTabId: nextActive });
    },

    renameTab: (id, name) =>
      commit({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, name } : t)) }),

    setActiveTab: (id) => set({ activeTabId: id }),

    // Force the chosen layout on the active tab. If the tab shows more terminals
    // than the layout can hold, drop the excess own-references (their processes
    // keep running in the sidebar) and compact the rest into the available slots.
    setLayout: (preset) => {
      const { tabs, activeTabId, panes } = get();
      // 'auto' fits up to the largest preset (6 slots); it never trims panes.
      const cap = preset === 'auto' ? 6 : LAYOUTS[preset].capacity;
      const paneIds = new Set(panes.map((p) => p.id));
      const newTabs = tabs.map((tab) => {
        if (tab.id !== activeTabId) return tab;
        const own = tab.items.filter((i) => paneIds.has(i.paneId));
        const ownSet = new Set(own.map((i) => i.paneId));
        // Pinned panes not already referenced here are forced in — they take slots.
        const pinnedExtras = panes.filter((p) => p.pinned && !ownSet.has(p.id)).length;
        const room = Math.max(0, cap - pinnedExtras);
        // Already fits and every item is on-grid → just set the layout.
        if (own.length <= room && own.every((i) => i.slot < cap)) {
          return { ...tab, layout: preset };
        }
        // Keep the first `room` by slot order; compact them into slots 0..room-1.
        const kept = [...own]
          .sort((a, b) => a.slot - b.slot)
          .slice(0, room)
          .map((i, idx) => ({ ...i, slot: idx }));
        return { ...tab, layout: preset, items: kept };
      });
      commit({ tabs: newTabs });
    },

    reorderTab: (dragId, targetId) => {
      const { tabs } = get();
      const from = tabs.findIndex((t) => t.id === dragId);
      const to = tabs.findIndex((t) => t.id === targetId);
      if (from < 0 || to < 0 || from === to) return;
      const arr = [...tabs];
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      commit({ tabs: arr });
    },

    togglePinTab: (id) =>
      commit({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)) }),

    addPane: (input) => {
      const { panes, tabs, activeTabId, runtime } = get();
      const tab = tabs.find((t) => t.id === activeTabId);
      if (!tab) return '';
      const shown = displayItems(tab, panes);
      const eff = resolveLayout(tab.layout, shown.length + 1);
      const nextLayout = tab.layout === 'auto' ? 'auto' : eff; // keep auto sticky
      let slot = input.slot ?? -1;
      const used = new Set(shown.map((i) => i.slot));
      if (slot < 0 || slot >= LAYOUTS[eff].capacity || used.has(slot))
        slot = firstEmptySlot(shown, eff);
      if (slot < 0) slot = shown.length;

      const pane: Pane = {
        id: input.id || uid(),
        name: input.name.trim() || 'Terminal',
        shell: input.shell,
        cwd: input.cwd,
        presetCommand: input.presetCommand?.trim() || undefined,
        autoStart: input.autoStart,
        projectId: input.projectId,
        kind: input.kind ?? 'shell',
        ssh: input.ssh,
        ephemeral: input.ephemeral || undefined,
      };
      commit({
        panes: [...panes, pane],
        tabs: tabs.map((t) =>
          t.id === activeTabId ? { ...t, layout: nextLayout, items: [...t.items, { paneId: pane.id, slot }] } : t
        ),
        runtime: {
          ...runtime,
          [pane.id]: {
            status: 'running',
            nonce: 0,
            runOnSpawn: !!pane.presetCommand,
            startedAt: Date.now(),
          },
        },
        focusedPaneId: pane.id,
      });
      return pane.id;
    },

    addTempPane: () => {
      const { shells, panes, settings } = get();
      const shell =
        SHELL_ORDER.find((k) => shells.some((sh) => sh.kind === k && sh.available)) ??
        (IS_WIN ? 'powershell' : 'git-bash');
      const n = panes.filter((p) => p.ephemeral).length + 1;
      get().addPane({
        name: `${translate(settings.language, 'temp.name')} ${n}`,
        shell,
        cwd: '',
        autoStart: false,
        ephemeral: true,
      });
    },

    openSftpForPane: (paneId) => {
      const { panes, settings } = get();
      const src = panes.find((p) => p.id === paneId);
      if (!src?.ssh) return;
      const { host, port, user } = src.ssh;
      // Reuse an existing browser pane for the same remote instead of duplicating.
      const existing = panes.find(
        (p) =>
          p.kind === 'browser' &&
          p.ssh &&
          p.ssh.host === host &&
          p.ssh.port === port &&
          p.ssh.user === user
      );
      if (existing) {
        get().showPaneInTab(existing.id);
        return;
      }
      const id = uid();
      // Secrets live in the OS keyring per pane id — copy the SSH pane's
      // password/passphrase so the browser can authenticate on its own.
      void secretCopy(paneId, id)
        .catch(() => {})
        .then(() => {
          get().addPane({
            id,
            name: `${translate(settings.language, 'sftp.name')} · ${src.name}`,
            shell: src.shell,
            cwd: '',
            autoStart: true,
            projectId: src.projectId,
            kind: 'browser',
            ssh: { ...src.ssh! },
          });
        });
    },

    showPaneInTab: (paneId, slot) => {
      const { panes, tabs, activeTabId, runtime } = get();
      if (!panes.some((p) => p.id === paneId)) return;
      if ((runtime[paneId]?.status ?? 'running') === 'exited') get().restartPane(paneId);
      const tab = tabs.find((t) => t.id === activeTabId);
      if (tab?.items.some((i) => i.paneId === paneId)) {
        set({ focusedPaneId: paneId });
        return;
      }
      referenceInActive(paneId, slot);
    },

    removeFromTab: (paneId) => {
      const { tabs, activeTabId, focusedPaneId } = get();
      commit({
        tabs: tabs.map((t) =>
          t.id === activeTabId ? { ...t, items: t.items.filter((i) => i.paneId !== paneId) } : t
        ),
        focusedPaneId: focusedPaneId === paneId ? null : focusedPaneId,
      });
    },

    movePaneToSlot: (paneId, slot) => {
      const { tabs, activeTabId, panes } = get();
      const tab = tabs.find((t) => t.id === activeTabId);
      if (!tab) return;
      const shown = displayItems(tab, panes);
      const current = shown.find((i) => i.paneId === paneId);
      const occupant = shown.find((i) => i.slot === slot && i.paneId !== paneId);
      const oldSlot = current?.slot ?? slot;
      const items = tab.items.map((i) => ({ ...i }));
      const ensure = (pid: string, s: number) => {
        const it = items.find((x) => x.paneId === pid);
        if (it) it.slot = s;
        else items.push({ paneId: pid, slot: s });
      };
      ensure(paneId, slot);
      if (occupant) ensure(occupant.paneId, oldSlot); // swap
      commit({
        tabs: tabs.map((t) => (t.id === activeTabId ? { ...t, items } : t)),
        focusedPaneId: paneId,
      });
    },

    stopPane: (paneId) => {
      // A temp terminal is one-shot: stopping it deletes it outright.
      if (get().panes.find((p) => p.id === paneId)?.ephemeral) {
        get().removePane(paneId);
        return;
      }
      killSession(paneId);
      const { runtime } = get();
      const prev =
        runtime[paneId] ?? { nonce: 0, runOnSpawn: false, status: 'running' as PaneStatus, startedAt: Date.now() };
      set({ runtime: { ...runtime, [paneId]: { ...prev, status: 'exited' } } });
    },

    stopAllPanes: () => get().stopPanesWhere(() => true),

    stopPanesWhere: (pred) => {
      const { panes, tabs, runtime, focusedPaneId } = get();
      const rt = { ...runtime };
      const removed = new Set<string>();
      for (const p of panes) {
        if ((p.kind ?? 'shell') === 'browser') continue;
        if ((rt[p.id]?.status ?? 'running') !== 'running') continue;
        if (!pred(p)) continue;
        killSession(p.id);
        if (p.ephemeral) {
          // Temp terminals are one-shot — stopping deletes them.
          delete rt[p.id];
          removed.add(p.id);
          continue;
        }
        const prev =
          rt[p.id] ?? { nonce: 0, runOnSpawn: false, status: 'running' as PaneStatus, startedAt: Date.now() };
        rt[p.id] = { ...prev, status: 'exited' };
      }
      if (removed.size === 0) {
        set({ runtime: rt });
        return;
      }
      commit({
        panes: panes.filter((p) => !removed.has(p.id)),
        tabs: tabs.map((t) => ({ ...t, items: t.items.filter((i) => !removed.has(i.paneId)) })),
        runtime: rt,
        focusedPaneId: focusedPaneId && removed.has(focusedPaneId) ? null : focusedPaneId,
      });
    },

    removePane: (paneId) => {
      killSession(paneId);
      secretDelete(paneId);
      const { panes, tabs, runtime, focusedPaneId } = get();
      const rt = { ...runtime };
      delete rt[paneId];
      commit({
        panes: panes.filter((p) => p.id !== paneId),
        tabs: tabs.map((t) => ({ ...t, items: t.items.filter((i) => i.paneId !== paneId) })),
        runtime: rt,
        focusedPaneId: focusedPaneId === paneId ? null : focusedPaneId,
      });
    },

    renamePane: (paneId, name) =>
      commit({ panes: get().panes.map((p) => (p.id === paneId ? { ...p, name } : p)) }),

    setBrowserPath: (paneId, side, path) => {
      const field = side === 'local' ? 'browserLocalPath' : 'browserRemotePath';
      const cur = get().panes.find((p) => p.id === paneId);
      if (!cur || cur[field] === path) return;
      commit({
        panes: get().panes.map((p) => (p.id === paneId ? { ...p, [field]: path } : p)),
      });
    },

    updatePane: (paneId, patch) => {
      const { panes, runtime } = get();
      let needRespawn = false;
      const newPanes = panes.map((p) => {
        if (p.id !== paneId) return p;
        if (
          (patch.shell !== undefined && patch.shell !== p.shell) ||
          (patch.cwd !== undefined && patch.cwd !== p.cwd) ||
          (patch.presetCommand !== undefined && patch.presetCommand !== p.presetCommand) ||
          (patch.kind !== undefined && patch.kind !== (p.kind ?? 'shell')) ||
          (patch.ssh !== undefined && JSON.stringify(patch.ssh) !== JSON.stringify(p.ssh))
        ) {
          needRespawn = true;
        }
        return { ...p, ...patch };
      });
      const rt = { ...runtime };
      if (needRespawn) {
        const updated = newPanes.find((p) => p.id === paneId);
        rt[paneId] = {
          status: 'running',
          nonce: (runtime[paneId]?.nonce ?? 0) + 1,
          runOnSpawn: !!updated?.presetCommand,
          startedAt: Date.now(),
        };
      }
      commit({ panes: newPanes, runtime: rt });
    },

    restartPane: (paneId) => {
      const { runtime } = get();
      const prev = runtime[paneId];
      set({
        runtime: {
          ...runtime,
          [paneId]: {
            status: 'running',
            nonce: (prev?.nonce ?? 0) + 1,
            runOnSpawn: false,
            startedAt: Date.now(),
          },
        },
      });
    },

    togglePinPane: (paneId) => {
      const { panes, tabs, activeTabId } = get();
      const target = panes.find((p) => p.id === paneId);
      if (!target) return;
      const nowPinned = !target.pinned;
      let newTabs = tabs;
      if (!nowPinned) {
        const tab = tabs.find((t) => t.id === activeTabId);
        if (tab && !tab.items.some((i) => i.paneId === paneId)) {
          const shown = displayItems(tab, panes);
          const layout = resolveLayout(tab.layout, shown.length);
          let slot = firstEmptySlot(shown, layout);
          if (slot < 0) slot = shown.length;
          newTabs = tabs.map((t) =>
            t.id === activeTabId ? { ...t, items: [...t.items, { paneId, slot }] } : t
          );
        }
      }
      commit({
        panes: panes.map((p) => (p.id === paneId ? { ...p, pinned: nowPinned } : p)),
        tabs: newTabs,
      });
    },

    setPaneStatus: (paneId, status, exitCode, exitError) => {
      // Temp terminal ended cleanly (e.g. the user typed `exit`) → delete it.
      // Spawn errors keep the pane so the overlay can show what went wrong.
      if (status === 'exited' && !exitError && get().panes.find((p) => p.id === paneId)?.ephemeral) {
        get().removePane(paneId);
        return;
      }
      const { runtime } = get();
      const prev =
        runtime[paneId] ?? { status: 'running', nonce: 0, runOnSpawn: false, startedAt: Date.now() };
      set({ runtime: { ...runtime, [paneId]: { ...prev, status, exitCode, exitError } } });
    },

    consumeRunOnSpawn: (paneId) => {
      const { runtime } = get();
      const info = runtime[paneId];
      if (!info?.runOnSpawn) return false;
      set({ runtime: { ...runtime, [paneId]: { ...info, runOnSpawn: false } } });
      return true;
    },

    setFocusedPane: (paneId) => set({ focusedPaneId: paneId }),

    updateSettings: (patch) => commit({ settings: { ...get().settings, ...patch } }),

    toggleSidebar: () =>
      commit({ settings: { ...get().settings, sidebarVisible: !get().settings.sidebarVisible } }),

    addProject: (name, path) => {
      const id = uid();
      commit({
        projects: [
          ...get().projects,
          { id, name: name.trim() || translate(get().settings.language, 'default.projectName'), path },
        ],
      });
      return id;
    },

    updateProject: (id, patch) =>
      commit({
        projects: get().projects.map((pr) => (pr.id === id ? { ...pr, ...patch } : pr)),
      }),

    removeProject: (id) =>
      commit({
        projects: get().projects.filter((pr) => pr.id !== id),
        // Detach terminals from the removed project.
        panes: get().panes.map((p) => (p.projectId === id ? { ...p, projectId: undefined } : p)),
      }),

    captureSnapshot: () => {
      const { snapshots } = get();
      const { tabs, panes } = withoutEphemeral(get().tabs, get().panes);
      const snap: Snapshot = {
        at: Date.now(),
        tabCount: tabs.length,
        cmdCount: panes.length,
        workspace: JSON.parse(JSON.stringify({ tabs, panes })) as { tabs: Tab[]; panes: Pane[] },
      };
      commit({ snapshots: [snap, ...snapshots].slice(0, MAX_SNAPSHOTS) });
    },

    restoreSnapshot: (at) => {
      const snap = get().snapshots.find((s) => s.at === at);
      if (!snap) return;
      const ws = JSON.parse(JSON.stringify(snap.workspace)) as { tabs: Tab[]; panes: Pane[] };
      const idMap = new Map<string, string>();
      const panes = ws.panes.map((p) => {
        const nid = uid();
        idMap.set(p.id, nid);
        return { ...p, id: nid };
      });
      const tabs = ws.tabs.map((t) => ({
        ...t,
        id: uid(),
        items: t.items
          .filter((it) => idMap.has(it.paneId))
          .map((it) => ({ ...it, paneId: idMap.get(it.paneId)! })),
      }));
      commit({
        tabs,
        panes,
        activeTabId: tabs[0]?.id ?? '',
        runtime: buildRuntime(panes, get().settings.autoRunCommand),
        ui: { ...get().ui, settingsOpen: false },
      });
    },

    rememberKey: (path) => {
      const p = path.trim();
      if (!p) return;
      const next = [p, ...get().recentKeys.filter((k) => k !== p)].slice(0, 20);
      commit({ recentKeys: next });
    },

    forgetKey: (path) => commit({ recentKeys: get().recentKeys.filter((k) => k !== path) }),

    exportData: () => {
      const s = get();
      const { tabs, panes } = withoutEphemeral(s.tabs, s.panes);
      return JSON.stringify(
        {
          version: STORE_VERSION,
          tabs,
          panes,
          projects: s.projects,
          activeTabId: s.activeTabId,
          settings: s.settings,
          snapshots: s.snapshots,
          recentKeys: s.recentKeys,
        },
        null,
        2
      );
    },

    importData: (json) => {
      try {
        const raw = JSON.parse(json);
        // Accept both the export shape and the raw plugin-store shape ({ state: {...} }).
        const p = raw && raw.state ? raw.state : raw;
        if (!p || !Array.isArray(p.tabs) || !Array.isArray(p.panes)) return false;
        const settings: Settings = { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) };
        const panes: Pane[] = p.panes;
        const tabs: Tab[] = p.tabs;
        const projects: Project[] = Array.isArray(p.projects) ? p.projects : [];
        const activeTabId = tabs.some((t) => t.id === p.activeTabId)
          ? p.activeTabId
          : tabs[0]?.id ?? '';
        commit({
          tabs,
          panes,
          projects,
          activeTabId,
          settings,
          snapshots: Array.isArray(p.snapshots) ? p.snapshots : [],
          recentKeys: Array.isArray(p.recentKeys) ? p.recentKeys : get().recentKeys,
          runtime: buildRuntime(panes, settings.autoRunCommand),
          focusedPaneId: null,
        });
        return true;
      } catch {
        return false;
      }
    },

    openAddCmd: (slot = null) =>
      set({ ui: { ...get().ui, addCmdOpen: true, addCmdSlot: slot, editPaneId: null } }),
    closeAddCmd: () => set({ ui: { ...get().ui, addCmdOpen: false, addCmdSlot: null } }),
    openEditCmd: (paneId) => set({ ui: { ...get().ui, editPaneId: paneId, addCmdOpen: false } }),
    closeEditCmd: () => set({ ui: { ...get().ui, editPaneId: null } }),
    openSettings: (section) =>
      set({ ui: { ...get().ui, settingsOpen: true, settingsSection: section ?? null } }),
    closeSettings: () => set({ ui: { ...get().ui, settingsOpen: false } }),
  };
});

export const activeTabSelector = (s: AppState): Tab | undefined =>
  s.tabs.find((t) => t.id === s.activeTabId);

export const findPane = (s: AppState, paneId: string): Pane | undefined =>
  s.panes.find((p) => p.id === paneId);
