// Shared domain types. The persisted shape (Store) mirrors what the Rust side
// and plugin-store read/write.

export type ShellKind = 'powershell' | 'cmd' | 'git-bash' | 'wsl';
/** What a pane hosts: a local shell, an SSH terminal, or a file browser. */
export type PaneKind = 'shell' | 'ssh' | 'browser';

/** SSH connection settings (secret lives in the OS credential store, not here). */
export interface SshConfig {
  host: string;
  port: number;
  user: string;
  auth: 'password' | 'key';
  /** Path to the private key file when auth === 'key'. */
  keyPath?: string;
  /** Remote start directory (SSH terminal: cd after login; browser: remote panel root). */
  remotePath?: string;
}
export type LayoutPreset =
  | 'single'
  | 'cols2'
  | 'rows2'
  | 'grid2x2'
  | 'big1plus2'
  | 'grid3x2';
/** A tab's layout: a fixed preset, or 'auto' (re-fits to the pane count). */
export type LayoutMode = LayoutPreset | 'auto';
export type PaneStatus = 'running' | 'exited';
export type FontSize = 'small' | 'medium' | 'large';
/** UI language. */
export type Lang = 'vi' | 'en';

/**
 * A cmd is a persistent, globally-managed terminal (listed in the sidebar). Its
 * process runs in the background regardless of which tabs display it.
 */
export interface Pane {
  id: string;
  name: string;
  shell: ShellKind;
  cwd: string;
  presetCommand?: string;
  autoStart: boolean;
  /** Pinned terminals are shown in every tab. */
  pinned?: boolean;
  /** Optional project this terminal belongs to (for sidebar grouping). */
  projectId?: string;
  /** Pane type — absent means 'shell' (backward compatible with old saves). */
  kind?: PaneKind;
  /** SSH settings for kind 'ssh', or the remote side of a 'browser' pane. */
  ssh?: SshConfig;
  /** Last-visited directories of a 'browser' pane, restored on reopen. */
  browserLocalPath?: string;
  browserRemotePath?: string;
  /** One-shot temp terminal: never persisted, auto-removed when its process stops. */
  ephemeral?: boolean;
}

/** A saved project (a working folder) used to group and quick-pick terminals. */
export interface Project {
  id: string;
  name: string;
  path?: string;
}

/** A tab's reference to a global pane, with its position in that tab's grid. */
export interface TabItem {
  paneId: string;
  slot: number;
}

/** A tab has its own set of cmd references + layout. */
export interface Tab {
  id: string;
  name: string;
  layout: LayoutMode;
  pinned: boolean;
  items: TabItem[];
}

/** An external editor the user registered for "Edit with…". */
export interface EditorApp {
  name: string;
  path: string;
}

export interface Settings {
  restoreOnStartup: boolean;
  restoreCwd: boolean;
  restoreGrid: boolean;
  autoRunCommand: boolean;
  defaultLayout: LayoutMode;
  shellPaths: Partial<Record<ShellKind, string>>;
  sidebarVisible: boolean;
  fontSize: FontSize;
  /** App-wide UI zoom factor (e.g. 0.9, 1, 1.1). */
  uiScale: number;
  /** "owner/repo" used by the GitHub update checker. */
  githubRepo: string;
  /** UI language (defaults to Vietnamese). */
  language: Lang;
  /** Exe used by "Edit" ('' = the OS default app for the extension). */
  defaultEditor: string;
  /** Editors offered in the "Edit with…" submenu. */
  editors: EditorApp[];
  /** Poll & show Claude Code plan usage in the toolbar widget. */
  usageClaude: boolean;
  /** Poll & show Cursor plan usage in the toolbar widget. */
  usageCursor: boolean;
}

export interface Snapshot {
  at: number;
  tabCount: number;
  cmdCount: number;
  workspace: { tabs: Tab[]; panes: Pane[] };
}

/** Persisted document. Panes (cmds) are global; tabs reference them for display. */
export interface PersistedState {
  version: number;
  tabs: Tab[];
  panes: Pane[];
  projects: Project[];
  activeTabId: string;
  settings: Settings;
  snapshots: Snapshot[];
  /** Private-key files (.pem/…) the user has picked before, newest first. */
  recentKeys?: string[];
}

/** Shape returned by the Rust `detect_shells` command. */
export interface ShellInfo {
  kind: ShellKind;
  label: string;
  path: string;
  available: boolean;
}

/** Runtime-only status for a live pane (never persisted). */
export interface PaneRuntime {
  status: PaneStatus;
  exitCode?: number;
}
