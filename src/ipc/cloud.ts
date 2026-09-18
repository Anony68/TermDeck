// IPC for E2EE cloud sync. Secrets never cross this boundary: the master password is
// passed to Rust only to unlock; hosts travel as non-secret JSON, and Rust reads/writes
// the actual credentials from the OS keyring + managed key files.
import { invoke } from '@tauri-apps/api/core';
import type { AccountMaterial, Host, SshConfig } from '../types';
import { IS_TAURI } from './env';

export type { AccountMaterial };

export interface RegisterResult {
  token: string;
  recoveryCode: string;
  account: AccountMaterial;
}
export interface RecoverResult {
  token: string;
  account: AccountMaterial;
}
export interface CloudStatus {
  signedIn: boolean;
  unlocked: boolean;
  email: string;
}
export interface PulledHost {
  id: string;
  hostJson: string;
  deleted: boolean;
  seq: number;
}
export interface PullResult {
  records: PulledHost[];
  cursor: number;
}

/** Flat vault-record shape for a host (matches what the Rust side reads/writes). */
interface HostRecord {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: 'password' | 'key';
  keyPath?: string;
  remotePath?: string;
  presetCommand?: string;
}

export function hostToRecordJson(h: Host): string {
  const rec: HostRecord = {
    id: h.id,
    name: h.name,
    host: h.ssh.host,
    port: h.ssh.port,
    user: h.ssh.user,
    auth: h.ssh.auth,
    keyPath: h.ssh.keyPath,
    remotePath: h.ssh.remotePath,
    presetCommand: h.presetCommand,
  };
  return JSON.stringify(rec);
}

export function recordJsonToHost(json: string): Host | null {
  try {
    const r = JSON.parse(json) as HostRecord;
    if (!r.id || !r.host) return null;
    const ssh: SshConfig = {
      host: r.host,
      port: r.port || 22,
      user: r.user || '',
      auth: r.auth === 'key' ? 'key' : 'password',
      keyPath: r.keyPath || undefined,
      remotePath: r.remotePath || undefined,
    };
    return { id: r.id, name: r.name || '', ssh, presetCommand: r.presetCommand || undefined };
  } catch {
    return null;
  }
}

export async function cloudRegister(baseUrl: string, email: string, masterPassword: string): Promise<RegisterResult> {
  return invoke('cloud_register', { baseUrl, email, masterPassword });
}
export async function cloudLoginFetch(baseUrl: string, email: string): Promise<AccountMaterial> {
  return invoke('cloud_login_fetch', { baseUrl, email });
}
export async function cloudUnlock(baseUrl: string, email: string, masterPassword: string, account: AccountMaterial): Promise<string> {
  return invoke('cloud_unlock', { baseUrl, email, masterPassword, account });
}
export async function cloudLock(): Promise<void> {
  if (!IS_TAURI) return;
  await invoke('cloud_lock');
}
export async function cloudStatus(): Promise<CloudStatus> {
  if (!IS_TAURI) return { signedIn: false, unlocked: false, email: '' };
  return invoke('cloud_status');
}
export async function cloudChangePassword(newMasterPassword: string): Promise<AccountMaterial> {
  return invoke('cloud_change_password', { newMasterPassword });
}
export async function cloudRecoverComplete(baseUrl: string, email: string, recoveryCode: string, newMasterPassword: string): Promise<RecoverResult> {
  return invoke('cloud_recover_complete', { baseUrl, email, recoveryCode, newMasterPassword });
}
export async function cloudPush(records: Array<{ id: string; hostJson?: string; deleted?: boolean }>): Promise<number> {
  return invoke('cloud_push', { records });
}
export async function cloudPull(since: number): Promise<PullResult> {
  return invoke('cloud_pull', { since });
}
