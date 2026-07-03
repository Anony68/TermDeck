import { useEffect } from 'react';
import { useStore } from './state/store';
import { detectShells, onPaneStats } from './ipc/api';
import { IS_TAURI } from './ipc/env';
import { LAYOUT_ORDER } from './layouts';
import { TitleBar } from './components/TitleBar';
import { Toolbar } from './components/Toolbar';
import { Sidebar } from './components/Sidebar';
import { Grid } from './components/Grid';
import { StatusBar } from './components/StatusBar';
import { TerminalLayer } from './components/TerminalLayer';
import { AddCmdDialog } from './dialogs/AddCmdDialog';
import { SettingsWindow } from './settings/SettingsWindow';

export default function App() {
  const hydrated = useStore((s) => s.hydrated);
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
    let unlisten: (() => void) | undefined;
    void onPaneStats((list) => useStore.getState().setStats(list)).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
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

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const k = e.key.toLowerCase();
      if (e.ctrlKey && !e.shiftKey && k === 't') {
        e.preventDefault();
        s.addTab();
      } else if (e.ctrlKey && k === 'n') {
        e.preventDefault();
        s.openAddCmd();
      } else if (e.ctrlKey && k === 'w') {
        if (s.focusedPaneId) {
          e.preventDefault();
          s.removePane(s.focusedPaneId);
        }
      } else if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        const i = s.tabs.findIndex((t) => t.id === s.activeTabId);
        const next = s.tabs[(i + 1) % s.tabs.length];
        if (next) s.setActiveTab(next.id);
      } else if (e.altKey && /^[1-6]$/.test(e.key)) {
        e.preventDefault();
        const preset = LAYOUT_ORDER[parseInt(e.key, 10) - 1];
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
        Đang tải…
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
