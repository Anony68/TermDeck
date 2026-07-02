import { invoke, Channel } from '@tauri-apps/api/core';
import type { ShellKind } from '../types';
import { IS_TAURI } from './env';

/** Mirror of the Rust `PtyEvent` enum (serde tag = "type"). */
type PtyEvent = { type: 'data'; data: number[] } | { type: 'exit'; code: number };

export interface SpawnOpts {
  paneId: string;
  shell: ShellKind;
  cwd: string;
  cols: number;
  rows: number;
  command?: string;
  shellPath?: string;
  onData: (bytes: Uint8Array) => void;
  onExit: (code: number) => void;
}

export async function spawnPty(o: SpawnOpts): Promise<void> {
  if (!IS_TAURI) return; // no-op in browser preview
  const channel = new Channel<PtyEvent>();
  channel.onmessage = (msg) => {
    if (msg.type === 'data') o.onData(new Uint8Array(msg.data));
    else o.onExit(msg.code);
  };
  await invoke('spawn_pty', {
    paneId: o.paneId,
    shell: o.shell,
    cwd: o.cwd,
    cols: o.cols,
    rows: o.rows,
    command: o.command ?? null,
    shellPath: o.shellPath ?? null,
    onEvent: channel,
  });
}

export function writePty(paneId: string, data: string): void {
  if (!IS_TAURI) return;
  void invoke('write_pty', { paneId, data });
}

export function resizePty(paneId: string, cols: number, rows: number): void {
  if (!IS_TAURI) return;
  void invoke('resize_pty', { paneId, cols, rows });
}

export function killPty(paneId: string): void {
  if (!IS_TAURI) return;
  void invoke('kill_pty', { paneId });
}
