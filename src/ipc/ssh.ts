// IPC for SSH terminals, SFTP sessions and the local-FS side of Browser panes.
import { invoke, Channel } from '@tauri-apps/api/core';
import type { SshConfig } from '../types';
import { IS_TAURI } from './env';

type PtyEvent = { type: 'data'; data: number[] } | { type: 'exit'; code: number };

export interface SpawnSshOpts {
  paneId: string;
  cfg: SshConfig;
  cols: number;
  rows: number;
  command?: string;
  onData: (bytes: Uint8Array) => void;
  onExit: (code: number) => void;
}

export async function spawnSsh(o: SpawnSshOpts): Promise<void> {
  if (!IS_TAURI) return;
  const channel = new Channel<PtyEvent>();
  channel.onmessage = (msg) => {
    if (msg.type === 'data') o.onData(new Uint8Array(msg.data));
    else o.onExit(msg.code);
  };
  await invoke('spawn_ssh', {
    paneId: o.paneId,
    cfg: o.cfg,
    cols: o.cols,
    rows: o.rows,
    command: o.command ?? null,
    onEvent: channel,
  });
}

export function writeSsh(paneId: string, data: string): void {
  if (!IS_TAURI) return;
  void invoke('write_ssh', { paneId, data });
}

export function resizeSsh(paneId: string, cols: number, rows: number): void {
  if (!IS_TAURI) return;
  void invoke('resize_ssh', { paneId, cols, rows });
}

export function killSsh(paneId: string): void {
  if (!IS_TAURI) return;
  void invoke('kill_ssh', { paneId });
}

export interface SshStatus {
  paneId: string;
  /** "connected" | "reconnecting" | "disconnected" */
  state: string;
  attempt: number;
}

/** Subscribe to SSH connection health/reconnect events. */
export async function onSshStatus(cb: (s: SshStatus) => void): Promise<() => void> {
  if (!IS_TAURI) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<SshStatus>('ssh://status', (e) => cb(e.payload));
}

export interface SshConfigHost {
  alias: string;
  hostName: string;
  user: string;
  port: number;
  identityFile: string;
}

/** Parse the user's ~/.ssh/config into concrete hosts (for the New-SSH dialog). */
export async function sshConfigHosts(): Promise<SshConfigHost[]> {
  if (!IS_TAURI) return [];
  try {
    return await invoke<SshConfigHost[]>('ssh_config_hosts');
  } catch {
    return [];
  }
}

/** Save (or clear with '') the password/passphrase for a pane in the OS credential store. */
export async function secretSet(paneId: string, value: string): Promise<void> {
  if (!IS_TAURI) return;
  await invoke('secret_set', { paneId, value });
}

export function secretDelete(paneId: string): void {
  if (!IS_TAURI) return;
  void invoke('secret_delete', { paneId });
}

// ---------- SFTP + local FS (Browser pane) ----------

export interface FileEntry {
  name: string;
  size: number;
  isDir: boolean;
  /** Unix seconds, 0 = unknown. */
  modified: number;
  perms: string;
  /** Unix permission bits (remote only; 0 for local). */
  mode: number;
  isSymlink: boolean;
}

export interface TransferProgress {
  paneId: string;
  name: string;
  done: number;
  total: number;
}

export async function sftpConnect(paneId: string, cfg: SshConfig): Promise<void> {
  await invoke('sftp_connect', { paneId, cfg });
}
export function sftpDisconnect(paneId: string): void {
  if (!IS_TAURI) return;
  void invoke('sftp_disconnect', { paneId });
}
export async function sftpList(paneId: string, path: string): Promise<FileEntry[]> {
  return await invoke('sftp_list', { paneId, path });
}
export async function sftpMkdir(paneId: string, path: string): Promise<void> {
  await invoke('sftp_mkdir', { paneId, path });
}
export async function sftpRename(paneId: string, from: string, to: string): Promise<void> {
  await invoke('sftp_rename', { paneId, from, to });
}
export async function sftpRemove(paneId: string, path: string, isDir: boolean): Promise<void> {
  await invoke('sftp_remove', { paneId, path, isDir });
}
export async function sftpChmod(paneId: string, path: string, mode: number): Promise<void> {
  await invoke('sftp_chmod', { paneId, path, mode });
}
export interface SearchHit {
  path: string;
  name: string;
  isDir: boolean;
}
export async function sftpSearch(paneId: string, root: string, query: string): Promise<SearchHit[]> {
  return await invoke('sftp_search', { paneId, root, query });
}
export async function sftpUpload(paneId: string, local: string, remote: string): Promise<void> {
  await invoke('sftp_upload', { paneId, local, remote });
}
export async function sftpDownload(paneId: string, remote: string, local: string): Promise<void> {
  await invoke('sftp_download', { paneId, remote, local });
}

export async function fsList(path: string): Promise<FileEntry[]> {
  return await invoke('fs_list', { path });
}
export async function fsMkdir(path: string): Promise<void> {
  await invoke('fs_mkdir', { path });
}
export async function fsRename(from: string, to: string): Promise<void> {
  await invoke('fs_rename', { from, to });
}
export async function fsRemove(path: string, isDir: boolean): Promise<void> {
  await invoke('fs_remove', { path, isDir });
}
export async function fsHome(): Promise<string> {
  if (!IS_TAURI) return '';
  return await invoke('fs_home');
}

export async function onSftpProgress(
  cb: (p: TransferProgress) => void
): Promise<() => void> {
  if (!IS_TAURI) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<TransferProgress>('sftp://progress', (e) => cb(e.payload));
}
