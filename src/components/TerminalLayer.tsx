import { useStore } from '../state/store';
import { KeepAliveTerminal } from './KeepAliveTerminal';

/**
 * Persistent layer holding one keep-alive SSH terminal per opened host, so the
 * connection survives switching between hosts. Re-renders only when the set of
 * terminal session ids changes (not on every state update).
 */
export function TerminalLayer() {
  // SFTP panes have no terminal — they render their own FileBrowser body.
  const idsKey = useStore((s) =>
    s.panes.filter((p) => p.kind === 'ssh').map((p) => p.id).join('|')
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
