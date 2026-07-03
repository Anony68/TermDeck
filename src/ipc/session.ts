// Kind-aware dispatch: a pane's byte stream is either a local PTY or an SSH
// channel; callers (chips, menus, xterm handlers) shouldn't care which.
import type { Pane } from '../types';
import { writePty, resizePty, killPty } from './pty';
import { writeSsh, resizeSsh, killSsh, sftpDisconnect } from './ssh';

export const paneKind = (p: Pane | undefined) => p?.kind ?? 'shell';

export function writeSession(pane: Pane, data: string): void {
  if (paneKind(pane) === 'ssh') writeSsh(pane.id, data);
  else writePty(pane.id, data);
}

export function resizeSession(pane: Pane, cols: number, rows: number): void {
  if (paneKind(pane) === 'ssh') resizeSsh(pane.id, cols, rows);
  else resizePty(pane.id, cols, rows);
}

/** Kill whatever lives behind the pane (PTY, SSH shell and/or SFTP session). */
export function killSession(paneId: string): void {
  killPty(paneId);
  killSsh(paneId);
  sftpDisconnect(paneId);
}
