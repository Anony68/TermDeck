// Shared domain types. The persisted shape (PersistedState) mirrors what the
// Rust side and plugin-store read/write.

/** SSH connection settings (secret lives in the OS credential store, not here). */
export interface SshConfig {
  host: string;
  port: number;
  user: string;
  auth: 'password' | 'key';
  /** Path to the private key file when auth === 'key'. */
  keyPath?: string;
  /** Remote start directory (SSH terminal: cd after login; SFTP: remote root). */
  remotePath?: string;
}

/** What an internal session hosts: an SSH terminal or an SFTP file manager. */
export type PaneKind = 'ssh' | 'browser';
export type PaneStatus = 'running' | 'exited';
export type FontSize = 'small' | 'medium' | 'large';
/** UI language. */
export type Lang = 'vi' | 'en';

/**
 * A VPS the user manages: one SSH connection. Selecting it opens a detail view
 * with an interactive SSH terminal and an SFTP file manager, both driven by this
 * one config + one stored secret.
 */
export interface Host {
  id: string;
  /** Display alias (falls back to user@host). */
  name: string;
  ssh: SshConfig;
  /** Optional command run once after the SSH terminal logs in. */
  presetCommand?: string;
}

/**
 * An internal session derived from a Host: `"{hostId}:term"` (kind 'ssh') or
 * `"{hostId}:sftp"` (kind 'browser'). Reuses the terminal/SFTP machinery keyed
 * by id. Not user-managed and not persisted on its own — rebuilt from Hosts.
 */
export interface Pane {
  id: string;
  name: string;
  kind: PaneKind;
  ssh: SshConfig;
  presetCommand?: string;
  /** Last-visited directories of the SFTP pane, restored on reopen. */
  browserLocalPath?: string;
  browserRemotePath?: string;
}

/** An external editor the user registered for "Edit with…". */
export interface EditorApp {
  name: string;
  path: string;
}

export interface Settings {
  /** Reselect the last active VPS on startup. */
  restoreOnStartup: boolean;
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
}

/** Non-secret account material cached so the vault can be unlocked offline after restart. */
export interface AccountMaterial {
  kdfVersion: number;
  saltHex: string;
  protectedVkHex: string;
  protectedVkNonceHex: string;
  recoverySaltHex: string;
  recoveryProtectedVkHex: string;
  recoveryProtectedVkNonceHex: string;
}

/** Persisted cloud-sync state (all non-secret: config, cached material, sync bookkeeping). */
export interface CloudPersisted {
  baseUrl: string;
  email: string;
  account: AccountMaterial | null;
  cursor: number;
  /** Host ids changed locally and not yet pushed. */
  dirty: string[];
  /** Host ids deleted locally and not yet pushed as tombstones. */
  pendingDeletes: string[];
}

/** Persisted document. */
export interface PersistedState {
  version: number;
  hosts: Host[];
  activeHostId: string | null;
  settings: Settings;
  /** Private-key files (.pem/…) the user has picked before, newest first. */
  recentKeys?: string[];
  /** Cloud-sync config + bookkeeping (absent when never signed in). */
  cloud?: CloudPersisted;
}
