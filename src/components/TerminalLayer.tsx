import { useStore } from '../state/store';
import { KeepAliveTerminal } from './KeepAliveTerminal';

/**
 * Persistent layer holding one keep-alive terminal per pane across ALL tabs, so
 * processes survive tab switches and moves. Re-renders only when the set of pane
 * ids changes (not on every state update).
 */
export function TerminalLayer() {
  const idsKey = useStore((s) => s.panes.map((p) => p.id).join('|'));
  const ids = idsKey ? idsKey.split('|') : [];
  return (
    <>
      {ids.map((id) => (
        <KeepAliveTerminal key={id} paneId={id} />
      ))}
    </>
  );
}
