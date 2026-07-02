import { create } from 'zustand';
import type {
  LayoutPreset,
  Pane,
  PaneStatus,
  PersistedState,
  Settings,
  ShellInfo,
  ShellKind,
  Snapshot,
  Tab,
  TabItem,
} from '../types';
import { LAYOUTS, fitLayout } from '../layouts';
import { loadPersisted, savePersisted } from '../ipc/persist';
import { killPty } from '../ipc/pty';

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
};

const STORE_VERSION = 4;
const MAX_SNAPSHOTS = 12;

interface RuntimeInfo {
  status: PaneStatus;
  exitCode?: number;
  nonce: number;
  runOnSpawn: boolean;
}

export interface NewPaneInput {
  name: string;
  shell: ShellKind;
  cwd: string;
  presetCommand?: string;
  autoStart: boolean;
  slot?: number;
}

interface AppState {
  tabs: Tab[];
  /** All cmds (the sidebar list). Each runs in the background regardless of tabs. */
  panes: Pane[];
  activeTabId: string;
  settings: Settings;
  snapshots: Snapshot[];

  runtime: Record<string, RuntimeInfo>;
  focusedPaneId: string | null;
  shells: ShellInfo[];
  ui: {
    addCmdOpen: boolean;
    addCmdSlot: number | null;
    settingsOpen: boolean;
    editPaneId: string | null;
  };
  hydrated: boolean;
  savedAt: number | null;

  hydrate: () => Promise<void>;
  setShells: (s: ShellInfo[]) => void;

  addTab: () => void;
  closeTab: (id: string) => void;
  renameTab: (id: string, name: string) => void;
  setActiveTab: (id: string) => void;
  setLayout: (preset: LayoutPreset) => void;
  reorderTab: (dragId: string, targetId: string) => void;
  togglePinTab: (id: string) => void;

  addPane: (input: NewPaneInput) => void;
  /** Show an existing cmd in the active tab (restarts it if stopped). */
  showPaneInTab: (paneId: string, slot?: number) => void;
  /** Hide a cmd from the active tab (process keeps running). */
  removeFromTab: (paneId: string) => void;
  /** Stop a cmd's process but keep the cmd (Tắt). */
  stopPane: (paneId: string) => void;
  /** Delete a cmd everywhere and kill its process (Xóa). */
  removePane: (paneId: string) => void;
  renamePane: (paneId: string, name: string) => void;
  updatePane: (paneId: string, patch: Partial<Pane>) => void;
  restartPane: (paneId: string) => void;
  togglePinPane: (paneId: string) => void;
  setPaneStatus: (paneId: string, status: PaneStatus, exitCode?: number) => void;
  consumeRunOnSpawn: (paneId: string) => boolean;
  setFocusedPane: (paneId: string | null) => void;

  updateSettings: (patch: Partial<Settings>) => void;
  toggleSidebar: () => void;

  captureSnapshot: () => void;
  restoreSnapshot: (at: number) => void;

  openAddCmd: (slot?: number | null) => void;
  closeAddCmd: () => void;
  openEditCmd: (paneId: string) => void;
  closeEditCmd: () => void;
  openSettings: () => void;
  closeSettings: () => void;
}

function freshTab(layout: LayoutPreset, name = 'Tab mới'): Tab {
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
  for (const p of panes)
    rt[p.id] = { status: 'running', nonce: 0, runOnSpawn: runOnSpawn && !!p.presetCommand };
  return rt;
}

// ---- debounced persistence ----
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(get: () => AppState) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = get();
    const persisted: PersistedState = {
      version: STORE_VERSION,
      tabs: s.tabs,
      panes: s.panes,
      activeTabId: s.activeTabId,
      settings: s.settings,
      snapshots: s.snapshots,
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
    const layout = fitLayout(shown.length + 1, tab.layout);
    let s = slot ?? -1;
    const used = new Set(shown.map((i) => i.slot));
    if (s < 0 || s >= LAYOUTS[layout].capacity || used.has(s)) s = firstEmptySlot(shown, layout);
    if (s < 0) s = shown.length;
    commit({
      tabs: tabs.map((t) =>
        t.id === activeTabId ? { ...t, layout, items: [...t.items, { paneId, slot: s }] } : t
      ),
      focusedPaneId: paneId,
    });
  };

  return {
    tabs: [freshTab('grid2x2', 'Tab 1')],
    panes: [],
    activeTabId: '',
    settings: DEFAULT_SETTINGS,
    snapshots: [],
    runtime: {},
    focusedPaneId: null,
    shells: [],
    ui: { addCmdOpen: false, addCmdSlot: null, settingsOpen: false, editPaneId: null },
    hydrated: false,
    savedAt: null,

    hydrate: async () => {
      const p = await loadPersisted();
      const settings: Settings = { ...DEFAULT_SETTINGS, ...(p?.settings ?? {}) };
      const snapshots = p?.snapshots ?? [];

      if (!p || p.version !== STORE_VERSION || !settings.restoreOnStartup) {
        const t = freshTab(settings.defaultLayout, 'Tab 1');
        set({ tabs: [t], panes: [], activeTabId: t.id, settings, snapshots, runtime: {}, hydrated: true });
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
        activeTabId,
        settings,
        snapshots,
        runtime: buildRuntime(panes, settings.autoRunCommand),
        hydrated: true,
      });
    },

    setShells: (shells) => set({ shells }),

    addTab: () => {
      const t = freshTab(get().settings.defaultLayout);
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

    setLayout: (preset) =>
      commit({
        tabs: get().tabs.map((t) => (t.id === get().activeTabId ? { ...t, layout: preset } : t)),
      }),

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
      if (!tab) return;
      const shown = displayItems(tab, panes);
      const layout = fitLayout(shown.length + 1, tab.layout);
      let slot = input.slot ?? -1;
      const used = new Set(shown.map((i) => i.slot));
      if (slot < 0 || slot >= LAYOUTS[layout].capacity || used.has(slot))
        slot = firstEmptySlot(shown, layout);
      if (slot < 0) slot = shown.length;

      const pane: Pane = {
        id: uid(),
        name: input.name.trim() || 'cmd',
        shell: input.shell,
        cwd: input.cwd,
        presetCommand: input.presetCommand?.trim() || undefined,
        autoStart: input.autoStart,
      };
      commit({
        panes: [...panes, pane],
        tabs: tabs.map((t) =>
          t.id === activeTabId ? { ...t, layout, items: [...t.items, { paneId: pane.id, slot }] } : t
        ),
        runtime: {
          ...runtime,
          [pane.id]: { status: 'running', nonce: 0, runOnSpawn: !!pane.presetCommand },
        },
        focusedPaneId: pane.id,
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

    stopPane: (paneId) => {
      killPty(paneId);
      const { runtime } = get();
      const prev = runtime[paneId] ?? { nonce: 0, runOnSpawn: false, status: 'running' as PaneStatus };
      set({ runtime: { ...runtime, [paneId]: { ...prev, status: 'exited' } } });
    },

    removePane: (paneId) => {
      killPty(paneId);
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

    updatePane: (paneId, patch) => {
      const { panes, runtime } = get();
      let needRespawn = false;
      const newPanes = panes.map((p) => {
        if (p.id !== paneId) return p;
        if (
          (patch.shell !== undefined && patch.shell !== p.shell) ||
          (patch.cwd !== undefined && patch.cwd !== p.cwd) ||
          (patch.presetCommand !== undefined && patch.presetCommand !== p.presetCommand)
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
          [paneId]: { status: 'running', nonce: (prev?.nonce ?? 0) + 1, runOnSpawn: false },
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
          const layout = fitLayout(shown.length, tab.layout);
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

    setPaneStatus: (paneId, status, exitCode) => {
      const { runtime } = get();
      const prev = runtime[paneId] ?? { status: 'running', nonce: 0, runOnSpawn: false };
      set({ runtime: { ...runtime, [paneId]: { ...prev, status, exitCode } } });
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

    captureSnapshot: () => {
      const { tabs, panes, snapshots } = get();
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

    openAddCmd: (slot = null) =>
      set({ ui: { ...get().ui, addCmdOpen: true, addCmdSlot: slot, editPaneId: null } }),
    closeAddCmd: () => set({ ui: { ...get().ui, addCmdOpen: false, addCmdSlot: null } }),
    openEditCmd: (paneId) => set({ ui: { ...get().ui, editPaneId: paneId, addCmdOpen: false } }),
    closeEditCmd: () => set({ ui: { ...get().ui, editPaneId: null } }),
    openSettings: () => set({ ui: { ...get().ui, settingsOpen: true } }),
    closeSettings: () => set({ ui: { ...get().ui, settingsOpen: false } }),
  };
});

export const activeTabSelector = (s: AppState): Tab | undefined =>
  s.tabs.find((t) => t.id === s.activeTabId);

export const findPane = (s: AppState, paneId: string): Pane | undefined =>
  s.panes.find((p) => p.id === paneId);
