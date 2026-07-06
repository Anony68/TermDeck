import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { spawnPty } from '../ipc/pty';
import { spawnSsh } from '../ipc/ssh';
import { writeSession, resizeSession, killSession, paneKind } from '../ipc/session';
import { copyText, pasteText } from '../ipc/clipboard';
import { useT } from '../i18n';
import { useStore, findPane } from '../state/store';
import { markPaneActivity, clearPaneActivity } from '../state/activity';
import { useSlots } from '../state/slots';
import { getTerminalHolder } from '../terminalHolder';
import { IS_TAURI } from '../ipc/env';
import { FONT_PX } from '../fontSizes';
import { ContextMenu } from './ContextMenu';

const THEME = {
  background: '#0b0e13',
  foreground: '#9aa7b5',
  cursor: '#dce3ea',
  cursorAccent: '#0b0e13',
  selectionBackground: 'rgba(45,212,167,0.25)',
  black: '#0b0e13',
  red: '#e5534b',
  green: '#2dd4a7',
  yellow: '#e5b34a',
  blue: '#4aa3ff',
  magenta: '#b48ead',
  cyan: '#3fe6b8',
  white: '#dce3ea',
  brightBlack: '#5b6472',
  brightRed: '#e5534b',
  brightGreen: '#3fe6b8',
  brightYellow: '#e5b34a',
  brightBlue: '#4aa3ff',
  brightMagenta: '#b48ead',
  brightCyan: '#3fe6b8',
  brightWhite: '#ffffff',
};

/**
 * Owns one xterm instance + PTY for the whole life of a pane, independent of which
 * tab/slot shows it. The host element is created imperatively and relocated with
 * `appendChild` (which MOVES the node, unlike React portals which recreate it), so
 * the process and scrollback survive tab switches and moves between tabs.
 */
export function KeepAliveTerminal({ paneId }: { paneId: string }) {
  const pane = useStore((s) => findPane(s, paneId));
  const nonce = useStore((s) => s.runtime[paneId]?.nonce ?? 0);
  const status = useStore((s) => s.runtime[paneId]?.status ?? 'running');
  const target = useSlots((s) => s.slots[paneId] ?? null);
  const fontPx = useStore((s) => FONT_PX[s.settings.fontSize]);

  // Detached host, created once and parked in the off-screen holder until placed.
  const [host] = useState(() => {
    const el = document.createElement('div');
    el.className = 'xterm-host';
    getTerminalHolder().appendChild(el);
    return el;
  });
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const paneRef = useRef(pane);
  paneRef.current = pane;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const t = useT();

  // Right-click: copy the selection if there is one, otherwise paste — like
  // Windows Terminal. Shift+right-click still opens the full context menu.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        setMenu({ x: e.clientX, y: e.clientY });
        return;
      }
      const term = termRef.current;
      if (term?.hasSelection()) {
        const sel = term.getSelection();
        void copyText(sel).then(() => term.clearSelection());
      } else {
        void pasteText().then((txt) => {
          const cur = paneRef.current;
          if (txt && cur) writeSession(cur, txt);
        });
      }
    };
    host.addEventListener('contextmenu', onCtx);
    return () => host.removeEventListener('contextmenu', onCtx);
  }, [host, paneId]);

  const refit = () => {
    const term = termRef.current;
    if (!term) return;
    try {
      fitRef.current?.fit();
      const p = paneRef.current;
      if (IS_TAURI && p) resizeSession(p, term.cols, term.rows);
    } catch {
      /* not laid out yet */
    }
  };

  // Create terminal + PTY. Re-runs only on restart (nonce), never on move.
  useEffect(() => {
    const p = paneRef.current;
    if (!p) return;
    const { setPaneStatus, consumeRunOnSpawn } = useStore.getState();

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: fontPx,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: THEME,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    termRef.current = term;
    fitRef.current = fit;
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);

    // Windows Terminal-style Ctrl+C / Ctrl+V: Ctrl+C copies when there's a
    // selection, otherwise falls through to the shell (SIGINT); Ctrl+V pastes.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return true;
      const key = e.key.toLowerCase();
      if (key === 'c' && term.hasSelection()) {
        e.preventDefault();
        const sel = term.getSelection();
        void copyText(sel).then(() => term.clearSelection());
        return false; // consumed as copy — don't send ^C
      }
      if (key === 'v') {
        e.preventDefault();
        void pasteText().then((txt) => {
          const cur = paneRef.current;
          if (txt && cur) writeSession(cur, txt);
        });
        return false; // consumed as paste
      }
      return true; // Ctrl+C with no selection (and everything else) → shell
    });

    let rafId = 0;
    const scheduleFit = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(refit);
    };
    scheduleFit();
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(host);
    window.addEventListener('resize', scheduleFit);
    const cleanupResize = () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      window.removeEventListener('resize', scheduleFit);
    };

    if (!IS_TAURI) {
      term.writeln(`\x1b[38;2;91;100;114m${t('term.previewNote')}\x1b[0m`);
      term.writeln(`\x1b[38;2;74;163;255m${p.shell}\x1b[0m  ${p.cwd || t('common.default')}`);
      return () => {
        cleanupResize();
        term.dispose();
      };
    }

    let disposed = false;
    const runCmd = consumeRunOnSpawn(paneId);
    const common = {
      onData: (bytes: Uint8Array) => {
        markPaneActivity(paneId);
        term.write(bytes);
      },
      onExit: (code: number, error?: string) => {
        if (!disposed) setPaneStatus(paneId, 'exited', code, error);
      },
    };
    const spawning =
      paneKind(p) === 'ssh' && p.ssh
        ? spawnSsh({
            paneId,
            cfg: p.ssh,
            cols: term.cols || 80,
            rows: term.rows || 24,
            // Land in the configured remote directory, then optionally run the preset.
            command:
              [
                p.ssh.remotePath?.trim() ? `cd "${p.ssh.remotePath.trim()}"` : '',
                runCmd && p.presetCommand ? p.presetCommand : '',
              ]
                .filter(Boolean)
                .join(' && ') || undefined,
            ...common,
          })
        : spawnPty({
            paneId,
            shell: p.shell,
            cwd: p.cwd,
            cols: term.cols || 80,
            rows: term.rows || 24,
            command: runCmd ? p.presetCommand : undefined,
            shellPath: useStore.getState().settings.shellPaths[p.shell],
            ...common,
          });
    spawning.catch((e) => {
      const err = t('term.connError', { err: String(e) });
      term.writeln(`\r\n\x1b[31m${err}\x1b[0m`);
      setPaneStatus(paneId, 'exited', -1, err);
    });

    const onData = term.onData((d) => {
      const cur = paneRef.current;
      if (cur) writeSession(cur, d);
    });

    return () => {
      disposed = true;
      onData.dispose();
      cleanupResize();
      killSession(paneId);
      clearPaneActivity(paneId);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, nonce]);

  // Relocate the host into its current slot (or the holder when its tab is
  // inactive / it has exited), then refit.
  useEffect(() => {
    const container = status === 'running' && target ? target : getTerminalHolder();
    if (host.parentElement !== container) container.appendChild(host);
    const id = requestAnimationFrame(refit);
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, status]);

  // Live font-size changes.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontPx;
    refit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontPx]);

  // Remove the host from the DOM when the pane is closed for good.
  useEffect(() => {
    return () => host.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!menu) return null;
  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      onClose={() => setMenu(null)}
      items={[
        {
          label: t('term.copy'),
          disabled: !termRef.current?.hasSelection(),
          onClick: () => {
            const term = termRef.current;
            if (term?.hasSelection()) void copyText(term.getSelection());
          },
        },
        {
          label: t('term.paste'),
          onClick: () =>
            void pasteText().then((txt) => {
              const cur = paneRef.current;
              if (txt && cur) writeSession(cur, txt);
            }),
        },
        { label: t('term.selectAll'), onClick: () => termRef.current?.selectAll() },
        { label: '', separator: true },
        { label: t('term.clear'), onClick: () => termRef.current?.clear() },
      ]}
    />
  );
}
