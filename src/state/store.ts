import { create } from 'zustand';
import type {
  AccountMaterial,
  CloudPersisted,
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
import {
  cloudRegister as ipcRegister,
  cloudLoginFetch,
  cloudUnlock as ipcUnlock,
  cloudLock as ipcLock,
  cloudChangePassword as ipcChangePassword,
  cloudRecoverComplete,
  cloudPush,
  cloudPull,
  hostToRecordJson,
  recordJsonToHost,
} from '../ipc/cloud';
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

/** Cloud-sync runtime state (persisted subset + live flags). */
interface CloudRuntime extends CloudPersisted {
  /** An account exists (registered/logged in on this device before). */
  signedIn: boolean;
  /** The vault is unlocked in Rust this session (VK held in memory). */
  unlocked: boolean;
  syncing: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
}

const EMPTY_CLOUD: CloudRuntime = {
  baseUrl: '',
  email: '',
  account: null,
  cursor: 0,
  dirty: [],
  pendingDeletes: [],
  signedIn: false,
  unlocked: false,
  syncing: false,
  lastSyncAt: null,
  lastError: null,
};

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

  cloud: CloudRuntime;

  ui: {
    addHostOpen: boolean;
    settingsOpen: boolean;
    settingsSection: string | null;
    editHostId: string | null;
    accountOpen: boolean;
  };
  hydrated: boolean;
  savedAt: number | null;

  hydrate: () => Promise<void>;

  // ---- cloud sync ----
  /** Register a new account; returns the one-time recovery code to show the user. */
  cloudRegister: (baseUrl: string, email: string, masterPassword: string) => Promise<string>;
  /** Unlock (and sign in) with the master password; then sync. */
  cloudUnlock: (baseUrl: string, email: string, masterPassword: string) => Promise<void>;
  /** Recover with the recovery code + set a new master password; then sync. */
  cloudRecover: (baseUrl: string, email: string, recoveryCode: string, newMasterPassword: string) => Promise<void>;
  cloudChangePassword: (newMasterPassword: string) => Promise<void>;
  cloudLock: () => void;
  /** Forget the account on this device (keeps local hosts). */
  cloudSignOut: () => void;
  /** Push local changes then pull remote ones and merge (no-op if locked). */
  cloudSync: () => Promise<void>;
  openAccount: () => void;
  closeAccount: () => void;

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

const dedupe = (arr: string[]) => Array.from(new Set(arr));
/** Mark a host changed locally (queues it for the next push). No-op if not signed in. */
const withDirty = (c: CloudRuntime, id: string): CloudRuntime =>
  c.signedIn ? { ...c, dirty: dedupe([...c.dirty, id]), pendingDeletes: c.pendingDeletes.filter((x) => x !== id) } : c;
/** Mark a host deleted locally (queues a tombstone). No-op if not signed in. */
const withDeleted = (c: CloudRuntime, id: string): CloudRuntime =>
  c.signedIn ? { ...c, pendingDeletes: dedupe([...c.pendingDeletes, id]), dirty: c.dirty.filter((x) => x !== id) } : c;

// ---- debounced persistence ----
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(get: () => AppState) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = get();
    const c = s.cloud;
    const persisted: PersistedState = {
      version: STORE_VERSION,
      hosts: s.hosts,
      activeHostId: s.activeHostId,
      settings: s.settings,
      recentKeys: s.recentKeys,
      cloud: c.signedIn
        ? {
            baseUrl: c.baseUrl,
            email: c.email,
            account: c.account,
            cursor: c.cursor,
            dirty: c.dirty,
            pendingDeletes: c.pendingDeletes,
          }
        : undefined,
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
    cloud: { ...EMPTY_CLOUD },
    ui: { addHostOpen: false, settingsOpen: false, settingsSection: null, editHostId: null, accountOpen: false },
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

      // Cloud is restored signed-in-but-locked: hosts render from local cache; the
      // user unlocks with the master password to sync + use secrets.
      const cloud: CloudRuntime = p?.cloud
        ? { ...EMPTY_CLOUD, ...p.cloud, signedIn: !!p.cloud.account, unlocked: false }
        : { ...EMPTY_CLOUD };

      set({ hosts, activeHostId, settings, recentKeys, cloud, hydrated: true });
    },

    addHost: (input) => {
      const id = input.id || uid();
      const host: Host = {
        id,
        name: input.name.trim(),
        ssh: input.ssh,
        presetCommand: input.presetCommand?.trim() || undefined,
      };
      commit({ hosts: [...get().hosts, host], activeHostId: id, cloud: withDirty(get().cloud, id) });
      if (get().cloud.unlocked) void get().cloudSync();
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
      commit({ hosts: newHosts, panes: newPanes, runtime: rt, cloud: withDirty(get().cloud, id) });
      if (get().cloud.unlocked) void get().cloudSync();
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
        cloud: withDeleted(get().cloud, id),
      });
      if (get().cloud.unlocked) void get().cloudSync();
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

    // ---- cloud sync ----

    cloudRegister: async (baseUrl, email, masterPassword) => {
      const res = await ipcRegister(baseUrl.trim(), email.trim(), masterPassword);
      // First sign-in: every existing local host must be pushed to the new vault.
      const dirty = get().hosts.map((h) => h.id);
      commit({
        cloud: {
          ...EMPTY_CLOUD,
          baseUrl: baseUrl.trim(),
          email: email.trim(),
          account: res.account,
          signedIn: true,
          unlocked: true,
          dirty,
        },
      });
      void get().cloudSync();
      return res.recoveryCode;
    },

    cloudUnlock: async (baseUrl, email, masterPassword) => {
      const bu = baseUrl.trim();
      const em = email.trim();
      // Use cached account material if present, else fetch it (fresh device).
      let account: AccountMaterial | null = get().cloud.account;
      if (!account || get().cloud.email !== em || get().cloud.baseUrl !== bu) {
        account = await cloudLoginFetch(bu, em);
      }
      await ipcUnlock(bu, em, masterPassword, account);
      commit({
        cloud: {
          ...get().cloud,
          baseUrl: bu,
          email: em,
          account,
          signedIn: true,
          unlocked: true,
          lastError: null,
        },
      });
      void get().cloudSync();
    },

    cloudRecover: async (baseUrl, email, recoveryCode, newMasterPassword) => {
      const res = await cloudRecoverComplete(baseUrl.trim(), email.trim(), recoveryCode.trim(), newMasterPassword);
      const dirty = get().hosts.map((h) => h.id);
      commit({
        cloud: {
          ...get().cloud,
          baseUrl: baseUrl.trim(),
          email: email.trim(),
          account: res.account,
          signedIn: true,
          unlocked: true,
          dirty,
          lastError: null,
        },
      });
      void get().cloudSync();
    },

    cloudChangePassword: async (newMasterPassword) => {
      const account = await ipcChangePassword(newMasterPassword);
      commit({ cloud: { ...get().cloud, account } });
    },

    cloudLock: () => {
      void ipcLock();
      set({ cloud: { ...get().cloud, unlocked: false } });
    },

    cloudSignOut: () => {
      void ipcLock();
      commit({ cloud: { ...EMPTY_CLOUD } });
    },

    cloudSync: async () => {
      const c0 = get().cloud;
      if (!c0.unlocked || c0.syncing) return;
      set({ cloud: { ...get().cloud, syncing: true, lastError: null } });
      try {
        // 1) Push local changes (only dirty hosts + tombstones).
        const hosts = get().hosts;
        const pushRecords = [
          ...c0.dirty
            .map((id) => hosts.find((h) => h.id === id))
            .filter((h): h is Host => !!h)
            .map((h) => ({ id: h.id, hostJson: hostToRecordJson(h) })),
          ...c0.pendingDeletes.map((id) => ({ id, deleted: true })),
        ];
        if (pushRecords.length) await cloudPush(pushRecords);

        // 2) Pull everything since our cursor (includes our own pushes + others').
        const res = await cloudPull(c0.cursor);
        let hostList = get().hosts.slice();
        for (const r of res.records) {
          if (r.deleted) {
            if (hostList.some((h) => h.id === r.id)) {
              // Local-only removal (do NOT re-queue a tombstone).
              killSession(termId(r.id));
              killSession(sftpId(r.id));
              secretDelete(termId(r.id));
              secretDelete(sftpId(r.id));
              stopEditsForPane(sftpId(r.id));
              hostList = hostList.filter((h) => h.id !== r.id);
            }
            continue;
          }
          const host = recordJsonToHost(r.hostJson);
          if (!host) continue;
          const idx = hostList.findIndex((h) => h.id === host.id);
          if (idx >= 0) hostList[idx] = host;
          else hostList.push(host);
        }
        const activeStillExists = hostList.some((h) => h.id === get().activeHostId);
        commit({
          hosts: hostList,
          activeHostId: activeStillExists ? get().activeHostId : hostList[0]?.id ?? null,
          cloud: {
            ...get().cloud,
            cursor: res.cursor,
            dirty: [],
            pendingDeletes: [],
            syncing: false,
            lastSyncAt: Date.now(),
          },
        });
      } catch (e) {
        set({ cloud: { ...get().cloud, syncing: false, lastError: String(e) } });
      }
    },

    openAccount: () => set({ ui: { ...get().ui, accountOpen: true } }),
    closeAccount: () => set({ ui: { ...get().ui, accountOpen: false } }),

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
