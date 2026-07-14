import { useEffect } from 'react';
import { useStore } from './state/store';
import { detectShells, onPaneStats } from './ipc/api';
import { IS_TAURI } from './ipc/env';
import { LAYOUT_ORDER } from './layouts';
import { IS_MAC } from './shells';
import { TitleBar } from './components/TitleBar';
import { Toolbar } from './components/Toolbar';
import { Sidebar } from './components/Sidebar';
import { Grid } from './components/Grid';
import { StatusBar } from './components/StatusBar';
import { TerminalLayer } from './components/TerminalLayer';
import { AddCmdDialog } from './dialogs/AddCmdDialog';
import { SettingsWindow } from './settings/SettingsWindow';
import { useT } from './i18n';
import { claudeSession, type ClaudeSession } from './ipc/claude';
import { onSshStatus } from './ipc/ssh';
import { wireEditUploads } from './state/edits';

export default function App() {
  const hydrated = useStore((s) => s.hydrated);
  const t = useT();
  const sidebarVisible = useStore((s) => s.settings.sidebarVisible);
  const uiScale = useStore((s) => s.settings.uiScale);
  const addCmdOpen = useStore((s) => s.ui.addCmdOpen);
  const editPaneId = useStore((s) => s.ui.editPaneId);
  const settingsOpen = useStore((s) => s.ui.settingsOpen);

  // App-wide zoom (font size for the whole UI).
  useEffect(() => {
    if (!IS_TAURI) {
      document.body.style.setProperty('zoom', String(uiScale));
      return;
    }
    void import('@tauri-apps/api/webview').then(({ getCurrentWebview }) =>
      getCurrentWebview().setZoom(uiScale).catch(() => {})
    );
  }, [uiScale]);

  // Startup: restore session + detect shells + snapshot the restored session.
  useEffect(() => {
    const s = useStore.getState();
    void s.hydrate().then(() => {
      const st = useStore.getState();
      if (st.panes.length > 0) st.captureSnapshot();
    });
    detectShells()
      .then((sh) => useStore.getState().setShells(sh))
      .catch(() => {});
    const unlisteners: Array<() => void> = [];
    void onPaneStats((list) => useStore.getState().setStats(list)).then((fn) =>
      unlisteners.push(fn)
    );
    void onSshStatus((s) =>
      useStore.getState().setSshStatus(s.paneId, s.state, s.attempt)
    ).then((fn) => unlisteners.push(fn));
    return () => unlisteners.forEach((fn) => fn());
  }, []);

  // Edit-in-place auto-upload pump: wired once here (not in FileBrowser, which
  // unmounts on tab switches while edits keep running in the background).
  useEffect(() => {
    wireEditUploads();
  }, []);

  // Poll Claude Code's real session state for panes that are running Claude.
  useEffect(() => {
    if (!IS_TAURI) return;
    let cancelled = false;
    const tick = async () => {
      const s = useStore.getState();
      const targets = s.panes.filter((p) => s.stats[p.id]?.claude && p.cwd);
      if (!targets.length) {
        if (Object.keys(s.claudeSessions).length) s.setClaudeSessions({});
        return;
      }
      const entries = await Promise.all(
        targets.map(async (p) => [p.id, await claudeSession(p.cwd)] as const)
      );
      if (cancelled) return;
      const map: Record<string, ClaudeSession> = {};
      for (const [id, sess] of entries) if (sess.found) map[id] = sess;
      useStore.getState().setClaudeSessions(map);
    };
    const iv = window.setInterval(tick, 1500);
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, []);

  // Block webview reload (F5 / Ctrl+R / Ctrl+Shift+R) — a reload would kill every
  // running terminal. F5 is repurposed to reload the focused file browser panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, []);

  // Global keyboard shortcuts. Primary modifier is Cmd on macOS, Ctrl elsewhere.
  // Tab switching stays on Ctrl+Tab everywhere (Cmd+Tab is the OS app switcher).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const k = e.key.toLowerCase();
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (mod && !e.shiftKey && k === 't') {
        e.preventDefault();
        s.addTab();
      } else if (mod && k === 'n') {
        e.preventDefault();
        s.openAddCmd();
      } else if (mod && k === 'w') {
        e.preventDefault(); // even unfocused: keep Cmd+W from closing the window
        if (s.focusedPaneId) s.removePane(s.focusedPaneId);
      } else if (mod && k === 'a') {
        // Block the webview's select-all from highlighting the whole UI. Real
        // inputs keep native behavior; terminals handle ^A themselves
        // (KeepAliveTerminal forwards it to the app running inside).
        const el = e.target as HTMLElement | null;
        const editable =
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          !!el?.isContentEditable;
        if (!editable) e.preventDefault();
      } else if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        const i = s.tabs.findIndex((t) => t.id === s.activeTabId);
        const next = s.tabs[(i + 1) % s.tabs.length];
        if (next) s.setActiveTab(next.id);
      } else if (e.altKey && /^Digit[1-6]$/.test(e.code)) {
        // e.code, not e.key: on macOS Option+digit types a special character.
        e.preventDefault();
        const preset = LAYOUT_ORDER[parseInt(e.code.slice(5), 10) - 1];
        if (preset) s.setLayout(preset);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!hydrated) {
    return (
      <div
        style={{
          height: '100%',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--text-muted)',
          font: '400 13px var(--font-ui)',
        }}
      >
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <TitleBar />
      <Toolbar />
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {sidebarVisible && <Sidebar />}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Grid />
        </div>
      </div>
      <StatusBar />
      <TerminalLayer />
      {(addCmdOpen || editPaneId) && <AddCmdDialog />}
      {settingsOpen && <SettingsWindow />}
    </div>
  );
}
