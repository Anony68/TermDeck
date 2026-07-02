import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { spawnPty, writePty, resizePty, killPty } from '../ipc/pty';
import { useStore, findPane } from '../state/store';
import { useSlots } from '../state/slots';
import { getTerminalHolder } from '../terminalHolder';
import { IS_TAURI } from '../ipc/env';
import { FONT_PX } from '../fontSizes';

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

  const refit = () => {
    const term = termRef.current;
    if (!term) return;
    try {
      fitRef.current?.fit();
      if (IS_TAURI) resizePty(paneId, term.cols, term.rows);
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
      term.writeln('\x1b[38;2;91;100;114m# Xem trước giao diện (chưa chạy trong Tauri).\x1b[0m');
      term.writeln(`\x1b[38;2;74;163;255m${p.shell}\x1b[0m  ${p.cwd || '(thư mục mặc định)'}`);
      return () => {
        cleanupResize();
        term.dispose();
      };
    }

    let disposed = false;
    const runCmd = consumeRunOnSpawn(paneId);
    spawnPty({
      paneId,
      shell: p.shell,
      cwd: p.cwd,
      cols: term.cols || 80,
      rows: term.rows || 24,
      command: runCmd ? p.presetCommand : undefined,
      shellPath: useStore.getState().settings.shellPaths[p.shell],
      onData: (bytes) => term.write(bytes),
      onExit: (code) => {
        if (!disposed) setPaneStatus(paneId, 'exited', code);
      },
    }).catch((e) => {
      term.writeln(`\r\n\x1b[31mLỗi mở shell: ${e}\x1b[0m`);
      setPaneStatus(paneId, 'exited', -1);
    });

    const onData = term.onData((d) => writePty(paneId, d));

    return () => {
      disposed = true;
      onData.dispose();
      cleanupResize();
      killPty(paneId);
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

  return null;
}
