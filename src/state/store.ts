import { create } from 'zustand';
import type {
  Host,
  Pane,
  PaneStatus,
  PersistedState,
  Settings,
  SshConfig,
} from '../types';
import { loadPersisted, savePersisted } from '../ipc/persist';
import { killSession } from '../ipc/session';
import { secretCopy, secretDelete } from '../ipc/ssh';
import { stopEditsForPane } from './edits';

const uid = () =>
  Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

/** Session ids derived from a host id — one SSH terminal, one SFTP browser. */
const termId = (hostId: string) => `${hostId}:term`;
const sftpId = (hostId: string) => `${hostId}:sftp`;

const DEFAULT_SETTINGS: Settings = {
  restoreOnStartup: true,
  sidebarVisible: true,
  fontSize: 'medium',
  uiScale: 1,
  githubRepo: '',
  language: 'vi',
  defaultEditor: '',
  editors: [],
};

const STORE_VERSION = 5;

interface RuntimeInfo {
  status: PaneStatus;
  exitCode?: number;
  /** Why the session failed/ended abnormally, shown on the exited overlay. */
  exitError?: string;
  nonce: number;
  runOnSpawn: boolean;
  /** When the current session started (ms epoch) — for uptime. */
  startedAt: number;
}

export interface NewHostInput {
  name: string;
  ssh: SshConfig;
  presetCommand?: string;
  /** Pre-generated id, so the caller can store a secret before the host mounts. */
  id?: string;
}

interface AppState {
  hosts: Host[];
  activeHostId: string | null;
  settings: Settings;
  /** Private-key files picked before, newest first (for the key auth dropdown). */
  recentKeys: string[];

  /** Internal sessions (SSH terminal / SFTP), created lazily per open host. */
  panes: Pane[];
  runtime: Record<string, RuntimeInfo>;
  /** Live SSH connection health per session ('reconnecting' while dropped). */
  sshStatus: Record<string, { state: string; attempt: number }>;
  focusedPaneId: string | null;

  ui: {
    addHostOpen: boolean;
    settingsOpen: boolean;
    settingsSection: string | null;
    editHostId: string | null;
  };
  hydrated: boolean;
  savedAt: number | null;

  hydrate: () => Promise<void>;

  /** Returns the new host's id (so callers can attach a secret to `{id}:term`). */
  addHost: (input: NewHostInput) => string;
  updateHost: (id: string, patch: Partial<Omit<Host, 'id'>>) => void;
  removeHost: (id: string) => void;
  setActiveHost: (id: string | null) => void;
  /** Ensure the SSH terminal session exists for a host (connects on mount). */
  ensureTerm: (hostId: string) => string;
  /** Ensure the SFTP session exists, copying the host's secret across first. */
  ensureSftp: (hostId: string) => Promise<string>;

  setPaneStatus: (paneId: string, status: PaneStatus, exitCode?: number, exitError?: string) => void;
  consumeRunOnSpawn: (paneId: string) => boolean;
  restartPane: (paneId: string) => void;
  setSshStatus: (paneId: string, state: string, attempt: number) => void;
  setBrowserPath: (paneId: string, side: 'local' | 'remote', path: string) => void;
  setFocusedPane: (paneId: string | null) => void;

  updateSettings: (patch: Partial<Settings>) => void;
  toggleSidebar: () => void;

  rememberKey: (path: string) => void;
  forgetKey: (path: string) => void;

  exportData: () => string;
  importData: (json: string) => boolean;

  openAddHost: () => void;
  closeAddHost: () => void;
  openEditHost: (id: string) => void;
  closeEditHost: () => void;
  openSettings: (section?: string) => void;
  closeSettings: () => void;
}

const hostLabel = (h: { name?: string; ssh: SshConfig }) =>
  h.name?.trim() || `${h.ssh.user}@${h.ssh.host}`;

// ---- debounced persistence ----
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(get: () => AppState) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = get();
    const persisted: PersistedState = {
      version: STORE_VERSION,
      hosts: s.hosts,
      activeHostId: s.activeHostId,
      settings: s.settings,
      recentKeys: s.recentKeys,
    };
    void savePersisted(persisted).then(() => useStore.setState({ savedAt: Date.now() }));
  }, 400);
}

/** Best-effort migration of a v4 terminal-dashboard doc into hosts. */
function migrateHosts(raw: unknown): Host[] {
  const doc = raw as { panes?: Array<Pane & { ssh?: SshConfig }> } | null;
  const panes = doc?.panes;
  if (!Array.isArray(panes)) return [];
  const seen = new Set<string>();
  const hosts: Host[] = [];
  for (const p of panes) {
    if (!p.ssh || (p.kind !== 'ssh' && p.kind !== 'browser')) continue;
    const key = `${p.ssh.host}:${p.ssh.port}:${p.ssh.user}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const id = uid();
    hosts.push({ id, name: hostLabel(p), ssh: p.ssh, presetCommand: p.presetCommand });
    // Preserve the stored password/passphrase: the old pane's keyring slot →
    // the new terminal session's slot. Best-effort; user re-enters if it fails.
    void secretCopy(p.id, termId(id)).catch(() => {});
  }
  return hosts;
}

export const useStore = create<AppState>((set, get) => {
  const commit = (partial: Partial<AppState>) => {
    set(partial);
    scheduleSave(get);
  };

  return {
    hosts: [],
    activeHostId: null,
    settings: DEFAULT_SETTINGS,
    recentKeys: [],
    panes: [],
    runtime: {},
    sshStatus: {},
    focusedPaneId: null,
    ui: { addHostOpen: false, settingsOpen: false, settingsSection: null, editHostId: null },
    hydrated: false,
    savedAt: null,

    hydrate: async () => {
      const p = await loadPersisted();
      const settings: Settings = { ...DEFAULT_SETTINGS, ...(p?.settings ?? {}) };
      const recentKeys = p?.recentKeys ?? [];

      let hosts: Host[] = [];
      let activeHostId: string | null = null;
      if (p && p.version === STORE_VERSION) {
        hosts = Array.isArray(p.hosts) ? p.hosts : [];
        activeHostId =
          settings.restoreOnStartup && hosts.some((h) => h.id === p.activeHostId)
            ? p.activeHostId
            : null;
      } else if (p) {
        hosts = migrateHosts(p); // v4 → v5 one-time upgrade
      }

      set({ hosts, activeHostId, settings, recentKeys, hydrated: true });
    },

    addHost: (input) => {
      const id = input.id || uid();
      const host: Host = {
        id,
        name: input.name.trim(),
        ssh: input.ssh,
        presetCommand: input.presetCommand?.trim() || undefined,
      };
      commit({ hosts: [...get().hosts, host], activeHostId: id });
      return id;
    },

    updateHost: (id, patch) => {
      const { hosts, panes, runtime } = get();
      const cur = hosts.find((h) => h.id === id);
      if (!cur) return;
      const sshChanged =
        patch.ssh !== undefined && JSON.stringify(patch.ssh) !== JSON.stringify(cur.ssh);
      const cmdChanged =
        patch.presetCommand !== undefined && patch.presetCommand !== cur.presetCommand;
      const newHosts = hosts.map((h) => (h.id === id ? { ...h, ...patch } : h));

      let newPanes = panes;
      const rt = { ...runtime };
      if (sshChanged) {
        // Drop the SFTP session so it re-copies the (possibly new) secret; bump
        // the terminal so it reconnects with the new config.
        killSession(sftpId(id));
        stopEditsForPane(sftpId(id));
        delete rt[sftpId(id)];
        newPanes = panes
          .filter((pn) => pn.id !== sftpId(id))
          .map((pn) =>
            pn.id === termId(id) ? { ...pn, ssh: patch.ssh!, name: hostLabel(newHosts.find((h) => h.id === id)!) } : pn
          );
        if (rt[termId(id)]) {
          killSession(termId(id));
          rt[termId(id)] = {
            status: 'running',
            nonce: (rt[termId(id)]?.nonce ?? 0) + 1,
            runOnSpawn: !!(patch.presetCommand ?? cur.presetCommand),
            startedAt: Date.now(),
          };
        }
      } else if (cmdChanged) {
        newPanes = panes.map((pn) =>
          pn.id === termId(id) ? { ...pn, presetCommand: patch.presetCommand } : pn
        );
      }
      commit({ hosts: newHosts, panes: newPanes, runtime: rt });
    },

    removeHost: (id) => {
      for (const pid of [termId(id), sftpId(id)]) {
        killSession(pid);
        secretDelete(pid);
        stopEditsForPane(pid);
      }
      const { hosts, panes, runtime, activeHostId, focusedPaneId } = get();
      const rt = { ...runtime };
      delete rt[termId(id)];
      delete rt[sftpId(id)];
      const remaining = hosts.filter((h) => h.id !== id);
      commit({
        hosts: remaining,
        panes: panes.filter((pn) => pn.id !== termId(id) && pn.id !== sftpId(id)),
        runtime: rt,
        activeHostId: activeHostId === id ? remaining[0]?.id ?? null : activeHostId,
        focusedPaneId:
          focusedPaneId === termId(id) || focusedPaneId === sftpId(id) ? null : focusedPaneId,
      });
    },

    setActiveHost: (id) => set({ activeHostId: id }),

    ensureTerm: (hostId) => {
      const id = termId(hostId);
      const { panes, runtime, hosts } = get();
      const host = hosts.find((h) => h.id === hostId);
      if (!host) return id;
      if (panes.some((pn) => pn.id === id)) return id;
      const pane: Pane = {
        id,
        name: hostLabel(host),
        kind: 'ssh',
        ssh: host.ssh,
        presetCommand: host.presetCommand,
      };
      set({
        panes: [...panes, pane],
        runtime: {
          ...runtime,
          [id]: {
            status: 'running',
            nonce: 0,
            runOnSpawn: !!host.presetCommand,
            startedAt: Date.now(),
          },
        },
      });
      return id;
    },

    ensureSftp: async (hostId) => {
      const id = sftpId(hostId);
      const { panes, runtime, hosts } = get();
      const host = hosts.find((h) => h.id === hostId);
      if (!host) return id;
      if (panes.some((pn) => pn.id === id)) return id;
      // Copy the host's secret (stored under the terminal slot) so SFTP can
      // authenticate on its own connection without re-prompting.
      await secretCopy(termId(hostId), id).catch(() => {});
      const pane: Pane = { id, name: hostLabel(host), kind: 'browser', ssh: host.ssh };
      set({
        panes: [...get().panes, pane],
        runtime: {
          ...runtime,
          [id]: { status: 'running', nonce: 0, runOnSpawn: false, startedAt: Date.now() },
        },
      });
      return id;
    },

    setPaneStatus: (paneId, status, exitCode, exitError) => {
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

    setSshStatus: (paneId, state, attempt) =>
      set({ sshStatus: { ...get().sshStatus, [paneId]: { state, attempt } } }),

    setBrowserPath: (paneId, side, path) => {
      const field = side === 'local' ? 'browserLocalPath' : 'browserRemotePath';
      const cur = get().panes.find((p) => p.id === paneId);
      if (!cur || cur[field] === path) return;
      set({ panes: get().panes.map((p) => (p.id === paneId ? { ...p, [field]: path } : p)) });
    },

    setFocusedPane: (paneId) => set({ focusedPaneId: paneId }),

    updateSettings: (patch) => commit({ settings: { ...get().settings, ...patch } }),

    toggleSidebar: () =>
      commit({ settings: { ...get().settings, sidebarVisible: !get().settings.sidebarVisible } }),

    rememberKey: (path) => {
      const p = path.trim();
      if (!p) return;
      const next = [p, ...get().recentKeys.filter((k) => k !== p)].slice(0, 20);
      commit({ recentKeys: next });
    },

    forgetKey: (path) => commit({ recentKeys: get().recentKeys.filter((k) => k !== path) }),

    exportData: () => {
      const s = get();
      return JSON.stringify(
        {
          version: STORE_VERSION,
          hosts: s.hosts,
          activeHostId: s.activeHostId,
          settings: s.settings,
          recentKeys: s.recentKeys,
        },
        null,
        2
      );
    },

    importData: (json) => {
      try {
        const raw = JSON.parse(json);
        const p = raw && raw.state ? raw.state : raw;
        if (!p || !Array.isArray(p.hosts)) return false;
        const settings: Settings = { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) };
        const hosts: Host[] = p.hosts;
        commit({
          hosts,
          activeHostId: hosts.some((h) => h.id === p.activeHostId) ? p.activeHostId : null,
          settings,
          recentKeys: Array.isArray(p.recentKeys) ? p.recentKeys : get().recentKeys,
        });
        return true;
      } catch {
        return false;
      }
    },

    openAddHost: () => set({ ui: { ...get().ui, addHostOpen: true, editHostId: null } }),
    closeAddHost: () => set({ ui: { ...get().ui, addHostOpen: false } }),
    openEditHost: (id) => set({ ui: { ...get().ui, editHostId: id, addHostOpen: false } }),
    closeEditHost: () => set({ ui: { ...get().ui, editHostId: null } }),
    openSettings: (section) =>
      set({ ui: { ...get().ui, settingsOpen: true, settingsSection: section ?? null } }),
    closeSettings: () => set({ ui: { ...get().ui, settingsOpen: false } }),
  };
});

export const findPane = (s: AppState, paneId: string): Pane | undefined =>
  s.panes.find((p) => p.id === paneId);

export const findHost = (s: AppState, hostId: string | null): Host | undefined =>
  hostId ? s.hosts.find((h) => h.id === hostId) : undefined;

export { termId, sftpId };
