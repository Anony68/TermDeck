import { useStore } from '../state/store';
import { KeepAliveTerminal } from './KeepAliveTerminal';

/**
 * Persistent layer holding one keep-alive terminal per pane across ALL tabs, so
 * processes survive tab switches and moves. Re-renders only when the set of pane
 * ids changes (not on every state update).
 */
export function TerminalLayer() {
  // Browser panes have no terminal/PTY — they render their own FileBrowser body.
  const idsKey = useStore((s) =>
    s.panes.filter((p) => (p.kind ?? 'shell') !== 'browser').map((p) => p.id).join('|')
  );
  const ids = idsKey ? idsKey.split('|') : [];
  return (
    <>
      {ids.map((id) => (
        <KeepAliveTerminal key={id} paneId={id} />
      ))}
    </>
  );
}
