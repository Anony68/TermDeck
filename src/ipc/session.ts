// A pane's byte stream is an SSH channel; callers (xterm handlers) go through
// these helpers so the terminal component stays transport-agnostic.
import type { Pane } from '../types';
import { writeSsh, resizeSsh, killSsh, sftpDisconnect } from './ssh';

export const paneKind = (p: Pane | undefined) => p?.kind ?? 'ssh';

export function writeSession(pane: Pane, data: string): void {
  writeSsh(pane.id, data);
}

export function resizeSession(pane: Pane, cols: number, rows: number): void {
  resizeSsh(pane.id, cols, rows);
}

/** Kill whatever lives behind the pane (SSH shell and/or SFTP session). */
export function killSession(paneId: string): void {
  killSsh(paneId);
  sftpDisconnect(paneId);
}
